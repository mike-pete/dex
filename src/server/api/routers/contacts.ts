import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { createInterface } from "readline";
import { type Readable } from "stream";
import invariant from "tiny-invariant";
import { z } from "zod";
import {
  type ColumnMapping,
  type InputSchema,
} from "~/app/api/v1/queue/handle-chunks/InputSchems";
import { env } from "~/env";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import pub from "~/server/connections/pusher";
import qstash from "~/server/connections/qstash";
import s3 from "~/server/connections/s3";
import { db } from "~/server/db";
import { chunks, contacts, files } from "~/server/db/schema";

async function queueChunk({
  csv,
  chunkNumber,
  fileId,
  createdById,
  lineCount,
  columnMapping,
}: z.infer<typeof InputSchema> & {
  lineCount: number;
  columnMapping: ColumnMapping;
}) {
  console.log(chunkNumber);

  await db.insert(chunks).values({
    fileId,
    chunkNumber: chunkNumber,
    lineCount,
    status: "PENDING" as const,
  });

  await qstash.publishJSON({
    url: `${env.NEXTAUTH_URL}/api/v1/queue/handle-chunks`,
    body: {
      csv,
      chunkNumber,
      fileId,
      createdById,
      columnMapping,
    },
    flowControl: {
      ratePerSecond: 100,
      parallelism: 10,
      key: `${fileId}`,
    },
  });
}

export const contactRouter = createTRPCRouter({
  getContacts: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const offset = (input.page - 1) * input.limit;

      const [userContacts, totalCount] = await Promise.all([
        ctx.db.query.contacts.findMany({
          where: (contactsTable, { eq }) =>
            eq(contactsTable.createdById, ctx.session.user.id),
          orderBy: [desc(contacts.createdAt)],
          limit: input.limit,
          offset: offset,
        }),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(contacts)
          .where(eq(contacts.createdById, ctx.session.user.id))
          .then((result) => Number(result[0]?.count ?? 0)),
      ]);

      return {
        contacts: userContacts,
        totalPages: Math.ceil(totalCount / input.limit),
        currentPage: input.page,
      };
    }),
  getUploadURL: protectedProcedure
    .input(z.object({ fileName: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [file] = await ctx.db
        .insert(files)
        .values({
          fileName: input.fileName,
          createdById: ctx.session.user.id,
        })
        .returning();

      invariant(file !== undefined, "expected file but got undefined");

      const command = new PutObjectCommand({
        Bucket: env.CLOUDFLARE_R2_BUCKET_NAME,
        Key: String(file.id),
      });

      const presignedURL = await getSignedUrl(s3, command, { expiresIn: 3600 });

      return { presignedURL, fileId: file.id };
    }),
  processFile: protectedProcedure
    .input(
      z.object({
        fileId: z.number(),
        columnMapping: z.object({
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          email: z.string(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const file = await ctx.db.query.files.findFirst({
        where: (files, { eq }) => eq(files.id, input.fileId),
      });

      if (!file) {
        throw new Error("File not found");
      }

      if (file.createdById !== ctx.session.user.id) {
        throw new Error("Unauthorized");
      }

      const command = new GetObjectCommand({
        Bucket: env.CLOUDFLARE_R2_BUCKET_NAME,
        Key: String(input.fileId),
      });

      const response = await s3.send(command);

      if (!response.Body) {
        throw new Error("File content is empty");
      }

      const stream = response.Body as Readable;
      const rl = createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      let headers: string | null = null;
      let currentChunk: string[] = [];
      let chunkIndex = 0;
      let bytesProcessed = 0;
      const CHUNK_SIZE = 10_000;
      const chunkSizes: { chunkNumber: string; lineCount: number }[] = [];
      const totalSize = Number(response.ContentLength ?? 0);

      const queue: Promise<void>[] = [];

      const queueCurrentChunk = () => {
        if (!currentChunk || currentChunk.length <= 1) return; // Skip empty chunks

        const chunkContent = currentChunk.join("\n");
        bytesProcessed += Buffer.byteLength(chunkContent, "utf8");

        const chunkingPercentage =
          totalSize > 0
            ? Math.min(Math.round((bytesProcessed / totalSize) * 100), 99) // Cap at 99% until fully complete
            : 0;

        queue.push(
          queueChunk({
            csv: chunkContent,
            fileId: input.fileId,
            chunkNumber: chunkIndex,
            createdById: file.createdById,
            lineCount: currentChunk.length - 1,
            columnMapping: input.columnMapping,
          }),
        );

        void pub.chunkQueued(ctx.session.user.id, {
          fileName: file.fileName,
          createdAt: file.createdAt.toISOString(),
          chunkingCompleted: false,
          chunkingPercentage,
          fileId: input.fileId,
        });
      };

      // Process chunks
      for await (const line of rl) {
        // Handle headers
        if (!headers) {
          headers = line;
          currentChunk.push(headers);
          continue;
        }

        invariant(headers, "Headers should be defined");
        currentChunk.push(line);

        // If chunk is full, process it
        const numberOfRowsExcludingHeaders = currentChunk.length - 1;
        if (numberOfRowsExcludingHeaders >= CHUNK_SIZE) {
          chunkSizes.push({
            chunkNumber: String(chunkIndex),
            lineCount: numberOfRowsExcludingHeaders,
          });
          queueCurrentChunk();
          currentChunk = [headers];
          chunkIndex++;
        }
      }

      if (currentChunk.length > 1) {
        chunkSizes.push({
          chunkNumber: String(chunkIndex),
          lineCount: currentChunk.length - 1,
        });
        queueCurrentChunk();
      }

      await Promise.all(queue);

      const [chunkCount] = await ctx.db
        .select({ count: sql<number>`CAST(count(*) AS integer)` })
        .from(chunks)
        .where(eq(chunks.fileId, input.fileId));

      if (chunkCount?.count !== chunkSizes.length) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Expected ${chunkSizes.length} chunks but got ${chunkCount?.count}`,
        });
      }

      await ctx.db
        .update(files)
        .set({ chunkingCompleted: true })
        .where(eq(files.id, input.fileId));

      await pub.chunkQueued(ctx.session.user.id, {
        fileName: file.fileName,
        createdAt: file.createdAt.toISOString(),
        chunkingCompleted: true,
        chunkingPercentage: 100,
        fileId: input.fileId,
      });
    }),
  getFilesStatus: protectedProcedure.query(async ({ ctx }) => {
    // Get all files with their chunk counts
    const allFiles = await ctx.db
      .select({
        fileId: files.id,
        fileName: files.fileName,
        totalChunks: sql<number>`CAST(count(${chunks.id}) AS integer)`.as(
          "total_chunks",
        ),
        doneChunks:
          sql<number>`CAST(count(case when ${chunks.status} = 'DONE' then 1 end) AS integer)`.as(
            "done_chunks",
          ),
        createdAt: files.createdAt,
        chunkingCompleted: files.chunkingCompleted,
      })
      .from(files)
      .leftJoin(chunks, eq(files.id, chunks.fileId))
      .where(eq(files.createdById, ctx.session.user.id))
      .groupBy(files.id);

    const filesStatus = Object.fromEntries(
      allFiles.map((file) => [
        file.fileId,
        {
          fileName: file.fileName,
          fileId: file.fileId,
          totalChunks: file.totalChunks || Infinity,
          doneChunks: file.doneChunks,
          chunkingCompleted: file.chunkingCompleted,
          createdAt: file.createdAt,
        },
      ]),
    );

    return filesStatus;
  }),
});

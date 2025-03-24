import Link from "next/link";
import { auth } from "~/server/auth";
import GoogleAuthButton from "./GoogleAuthButton";
import Row from "./Row";

export default async function NavBar() {
  const session = await auth();

  return (
    <Row className="sticky top-0 z-50 w-full items-center border-b border-neutral-700 bg-neutral-950 p-4">
      <Row className="flex-1 items-center gap-4">
        <Link href="/" className="font-bold text-emerald-500">
          CMS
        </Link>
        {session?.user && (
          <Link href="/dashboard" className="text-sm font-semibold">
            dashboard
          </Link>
        )}
      </Row>
      <GoogleAuthButton />
    </Row>
  );
}

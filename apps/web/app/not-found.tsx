import Link from "next/link"
export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p>This page is unavailable or you no longer have access.</p>
      <Link className="underline" href="/dashboard">
        Go to dashboard
      </Link>
    </main>
  )
}

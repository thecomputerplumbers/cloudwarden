import Link from "next/link"
import { Building2 } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  Brand,
  BrandMark,
  BrandWordmark,
} from "@workspace/ui-shell/components/brand"
import { ThemeToggle } from "@workspace/ui-shell/components/theme-toggle"
import { getServerSession } from "@/lib/session"
import product from "@/config/product.json"
export default async function Home() {
  const session = await getServerSession()
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Brand render={<Link href="/" />}>
          <BrandMark>
            <Building2 />
          </BrandMark>
          <BrandWordmark>{product.name}</BrandWordmark>
        </Brand>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 flex-col items-start justify-center gap-6 py-20">
        <h1 className="max-w-2xl text-5xl font-semibold tracking-tight">
          {product.name}
        </h1>
        <p className="max-w-xl text-xl text-muted-foreground">
          {product.description}
        </p>
        <div className="flex gap-3">
          <Button render={<Link href={session ? "/dashboard" : "/sign-up"} />}>
            {session ? "Open workspace" : "Get started"}
          </Button>
          {!session && (
            <Button variant="outline" render={<Link href="/sign-in" />}>
              Sign in
            </Button>
          )}
        </div>
      </main>
      <footer className="border-t py-6 text-sm text-muted-foreground">
        <a href={`mailto:${product.supportEmail}`}>Contact support</a>
      </footer>
    </div>
  )
}

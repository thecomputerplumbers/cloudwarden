import Link from "next/link"
import { AccountPage } from "@/components/account-page"
import { requireServerSession } from "@/lib/session"
import product from "@/config/product.json"
export default async function DashboardPage() {
  const { user } = await requireServerSession()
  return (
    <AccountPage title={`Welcome, ${user.name.split(" ")[0]}`}>
      <p className="text-muted-foreground">{product.description}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {product.navigation
          .filter(
            (item) =>
              item.href !== "/dashboard" &&
              (!item.feature ||
                product.features[item.feature as keyof typeof product.features])
          )
          .map((item) => (
            <Link
              className="rounded-lg border p-5 font-medium hover:bg-muted"
              key={item.href}
              href={item.href}
            >
              {item.label}
            </Link>
          ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Need help?{" "}
        <a className="underline" href={`mailto:${product.supportEmail}`}>
          {product.supportEmail}
        </a>
      </p>
    </AccountPage>
  )
}

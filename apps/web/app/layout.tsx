import product from "@/config/product.json"
export const metadata = {
  title: { default: product.name, template: `%s | ${product.name}` },
  description: product.description,
}
import "@workspace/ui/globals.css"
import { ThemeProvider } from "@/components/theme-provider"

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning className="font-sans antialiased">
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}

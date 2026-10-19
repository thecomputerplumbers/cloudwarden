import product from "@/config/product.json"
export const metadata = {
  title: { default: product.name, template: `%s | ${product.name}` },
  description: product.description,
}
// Imported here, not from the stylesheet, so Vite emits the font files the CSS points at.
import "@fontsource-variable/archivo/standard.css"
import "@fontsource-variable/jetbrains-mono"
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

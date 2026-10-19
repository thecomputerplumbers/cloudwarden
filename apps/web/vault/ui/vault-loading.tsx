import { Spinner } from "@workspace/ui/components/spinner"
import { BrandMark } from "./brand.tsx"

export function VaultLoading({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex h-dvh flex-col items-center justify-center gap-4 bg-background"
    >
      <BrandMark className="size-10 animate-pulse" />
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {message}
      </p>
    </div>
  )
}

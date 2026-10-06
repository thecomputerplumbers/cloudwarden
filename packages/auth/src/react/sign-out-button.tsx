"use client"

import * as React from "react"
import { LogOut } from "lucide-react"

import { Button } from "@workspace/ui/components/button"

import { authClient } from "@workspace/auth/client"

/**
 * Signs out and reloads.
 *
 * The reload is deliberate: clearing the cookie is not enough on its own,
 * because already-rendered server components still hold the signed-in view.
 */
function SignOutButton({
  redirectTo = "/",
  children = "Sign out",
  variant = "ghost",
  size = "sm",
  ...props
}: React.ComponentProps<typeof Button> & { redirectTo?: string }) {
  const [pending, setPending] = React.useState(false)

  return (
    <Button
      variant={variant}
      size={size}
      disabled={pending}
      onClick={async () => {
        setPending(true)
        await authClient.signOut()
        window.location.assign(redirectTo)
      }}
      {...props}
    >
      <LogOut />
      {children}
    </Button>
  )
}

export { SignOutButton }

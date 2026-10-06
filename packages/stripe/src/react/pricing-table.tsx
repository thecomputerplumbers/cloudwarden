"use client"

import * as React from "react"
import { Check } from "lucide-react"
import { cn } from "cn"

import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

import { CheckoutButton } from "@workspace/stripe/react/checkout-button"

export type PricingPlan = {
  /** Your own key for the plan. Sent to the checkout route, not a price id. */
  id: string
  name: string
  description?: string
  /** Pre-formatted, e.g. "$29". Formatting money is a locale decision. */
  price: string
  /** "per month", "one time" — the qualifier after the amount. */
  cadence?: string
  features?: string[]
  badge?: string
  /** Lifts the card and fills the button. One plan at most. */
  featured?: boolean
  cta?: string
  /** Renders as a disabled button with this label — for the current plan. */
  currentLabel?: string
}

/**
 * The plan chooser.
 *
 * Each card posts its plan `id` to your checkout route; the route maps that
 * id to a Stripe price. The browser never sends a price id or an amount,
 * which is the whole point — a price that arrives from the client is a price
 * anyone can edit.
 *
 * ```tsx
 * <PricingTable
 *   endpoint="/api/stripe/checkout"
 *   plans={[
 *     { id: "pro-monthly", name: "Pro", price: "$29", cadence: "per month", featured: true },
 *   ]}
 * />
 * ```
 */
function PricingTable({
  plans,
  endpoint = "/api/stripe/checkout",
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  plans: PricingPlan[]
  endpoint?: string
}) {
  return (
    <div
      data-slot="pricing-table"
      className={cn(
        "grid gap-4 sm:grid-cols-2",
        plans.length >= 3 && "lg:grid-cols-3",
        className
      )}
      {...props}
    >
      {plans.map((plan) => (
        <Card
          key={plan.id}
          data-featured={plan.featured || undefined}
          className={cn(
            "relative",
            plan.featured && "ring-2 ring-primary lg:-translate-y-2"
          )}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {plan.name}
              {plan.badge ? (
                <Badge variant={plan.featured ? "default" : "secondary"}>
                  {plan.badge}
                </Badge>
              ) : null}
            </CardTitle>
            {plan.description ? (
              <CardDescription>{plan.description}</CardDescription>
            ) : null}
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <p className="flex items-baseline gap-1.5">
              <span className="font-heading text-3xl font-semibold tabular-nums">
                {plan.price}
              </span>
              {plan.cadence ? (
                <span className="text-sm text-muted-foreground">
                  {plan.cadence}
                </span>
              ) : null}
            </p>

            {plan.features?.length ? (
              <ul className="flex flex-col gap-2 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="text-muted-foreground">{feature}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>

          <CardFooter>
            {plan.currentLabel ? (
              <span className="text-sm text-muted-foreground">
                {plan.currentLabel}
              </span>
            ) : (
              <CheckoutButton
                endpoint={endpoint}
                body={{ plan: plan.id }}
                variant={plan.featured ? "default" : "outline"}
                className="w-full"
                wrapperClassName="w-full"
              >
                {plan.cta ?? `Choose ${plan.name}`}
              </CheckoutButton>
            )}
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}

export { PricingTable }

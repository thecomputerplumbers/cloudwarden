import product from "@/config/product.json"
import { notFound } from "next/navigation"
import Link from "next/link"
import { CreditCard, ShieldCheck } from "lucide-react"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  AppShell,
  AppShellHeader,
  AppShellMain,
  AppShellTitle,
} from "@workspace/ui-shell/components/app-shell"
import {
  Eyebrow,
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@workspace/ui-shell/components/page-header"
import {
  Siderail,
  SiderailContent,
  SiderailHeading,
  SiderailLayout,
  SiderailNote,
  SiderailSection,
} from "@workspace/ui-shell/components/siderail"
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@workspace/ui-data/components/description-list"
import { EmptyState } from "@workspace/ui-data/components/empty-state"
import { StatusBadge, statusTone } from "@workspace/ui-data/components/status"
import { formatDate } from "@workspace/ui-data/lib/format"
import type { StripeSubscriptionRow } from "@workspace/stripe/schema"
import { getSubscriptionByOrganization } from "@workspace/stripe/store"
import { ManageBillingButton } from "@workspace/stripe/react/manage-billing-button"
import { PricingTable } from "@workspace/stripe/react/pricing-table"

import { getDb } from "@/db"
import { requireActiveOrganization } from "@/lib/session"
import { stripeConfig } from "@/lib/stripe"

/**
 * Plans are described here for display and priced in Stripe. The `id` is the
 * plan key the checkout route maps to a price — never a price id, which would
 * let the browser choose what it pays.
 */
const plans = product.plans

export default async function BillingPage() {
  if (!product.features.billing) notFound()
  const config = stripeConfig()
  const { organizationId } = await requireActiveOrganization()

  // The local read model, written by the webhook. It is only as fresh as the
  // last event, which is the right trade for a page render.
  const subscription: StripeSubscriptionRow | null =
    await getSubscriptionByOrganization(
      getDb(),
      organizationId,
      config.livemode
    )

  return (
    <AppShell sidebar={null} defaultSidebarOpen={false}>
      <AppShellHeader trigger={false}>
        <AppShellTitle>Billing</AppShellTitle>
      </AppShellHeader>

      <AppShellMain width="default">
        <PageHeader>
          <PageHeaderContent>
            <Eyebrow>Plans</Eyebrow>
            <PageHeaderTitle>Choose how you pay</PageHeaderTitle>
            <PageHeaderDescription>
              Checkout and the billing portal are Stripe&rsquo;s own hosted
              pages, so no card details ever reach this app.
            </PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

        {!config.livemode && (
          <Alert className="mb-6">
            <ShieldCheck />
            <AlertTitle>Stripe is in test mode</AlertTitle>
            <AlertDescription>
              Card <code>4242 4242 4242 4242</code> with any future expiry
              completes a test payment. Use a separate live deployment to take
              real money.
            </AlertDescription>
          </Alert>
        )}

        <SiderailLayout>
          <SiderailContent>
            {subscription ? (
              <div className="flex flex-col gap-6">
                <DescriptionList>
                  <DescriptionTerm>Status</DescriptionTerm>
                  <DescriptionDetails>
                    <StatusBadge tone={statusTone(subscription.status)}>
                      {subscription.status}
                    </StatusBadge>
                  </DescriptionDetails>

                  <DescriptionTerm>Plan</DescriptionTerm>
                  <DescriptionDetails>
                    {subscription.priceId ?? "—"}
                  </DescriptionDetails>

                  <DescriptionTerm>
                    {subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}
                  </DescriptionTerm>
                  <DescriptionDetails>
                    {subscription.currentPeriodEnd
                      ? formatDate(subscription.currentPeriodEnd)
                      : "—"}
                  </DescriptionDetails>
                </DescriptionList>

                <ManageBillingButton returnPath="/billing" />
              </div>
            ) : (
              <PricingTable plans={plans} />
            )}
          </SiderailContent>

          <Siderail variant="panel">
            <SiderailSection>
              <SiderailHeading>How this works</SiderailHeading>
              <SiderailNote>
                Choosing a plan opens Stripe Checkout. Access is granted when
                the webhook arrives — not when the browser comes back, which
                proves nothing on its own.
              </SiderailNote>
              <SiderailNote>
                Billing belongs to the organization, not to you personally, so
                only an owner or admin can change it.
              </SiderailNote>
            </SiderailSection>

            <SiderailSection>
              <SiderailHeading>Already subscribed?</SiderailHeading>
              <SiderailNote>
                The billing portal is where a card is changed, an invoice
                downloaded, or a plan cancelled.
              </SiderailNote>
              <ManageBillingButton returnPath="/billing" size="sm" />
            </SiderailSection>

            <SiderailSection>
              <SiderailHeading>Not configured yet?</SiderailHeading>
              <EmptyState
                icon={CreditCard}
                title={"Stripe configuration"}
                description={
                  <>
                    Set the keys and price ids, then check{" "}
                    <Link href="/api/health">/api/health</Link>.
                  </>
                }
                bordered={false}
                className="p-0"
              />
            </SiderailSection>
          </Siderail>
        </SiderailLayout>

        <div className="mt-10">
          <Button variant="ghost" size="sm" render={<Link href="/dashboard" />}>
            Back to dashboard
          </Button>
        </div>
      </AppShellMain>
    </AppShell>
  )
}

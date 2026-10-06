# @workspace/ui-data

Showing data: numbers, tables, states, time.

## Components

| File               | Exports                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `stat-card`        | `StatGrid`, `StatCard`, `StatLabel`, `StatValue`, `StatUnit`, `StatDelta`                                             |
| `data-table`       | `DataTable`, `DataTableColumn`                                                                                        |
| `empty-state`      | `EmptyState`                                                                                                          |
| `status`           | `StatusDot`, `StatusBadge`, `statusTone`, `StatusTone`                                                                |
| `description-list` | `DescriptionList`, `DescriptionTerm`, `DescriptionDetails`, `DescriptionRow`                                          |
| `timeline`         | `Timeline`, `TimelineItem`, `TimelineTitle`, `TimelineDescription`, `TimelineTime`                                    |
| `lib/format`       | `formatMoney`, `formatNumber`, `formatCompact`, `formatPercent`, `formatRelativeTime`, `formatDate`, `deltaDirection` |

## `DataTable` is presentational

There is no sorting, filtering or pagination engine in here, on purpose. That
belongs to whoever owns the data — a server query, or TanStack Table if you
want it client-side. What this owns is the markup, the loading skeleton and
the empty state, so every table in the app agrees on those.

```tsx
<DataTable
  rows={invoices}
  getRowId={(invoice) => invoice.id}
  empty={<EmptyState icon={Inbox} title="No invoices yet" bordered={false} />}
  columns={[
    { id: "number", header: "Invoice", cell: (i) => i.number },
    {
      id: "total",
      header: "Total",
      align: "end",
      cell: (i) => formatMoney(i.total),
    },
  ]}
/>
```

`align: "end"` also switches the cell to `tabular-nums`, so digits line up
down the column.

## Status has one vocabulary

`StatusTone` — `neutral`, `info`, `success`, `warning`, `danger`, `pending` —
is shared by the dot, the badge and the timeline, so a "running" job looks the
same everywhere. `statusTone("past_due")` maps common state strings onto it so
call sites do not each invent their own mapping.

Colour never carries the meaning alone: `StatusDot` is `aria-hidden` and meant
to sit beside the status word, and `StatDelta` pairs its tone with an
arrow.

## `StatDelta` and direction

`direction` sets the arrow. `intent` sets whether that direction is good:

```tsx
<StatDelta direction="up">12%</StatDelta>
<StatDelta direction="up" intent="down-is-good">0.4pt</StatDelta>
```

The second is churn going the wrong way — the arrow still points up, the tone
turns red.

## Formatting

`formatMoney` takes **minor units**, because that is how payment processors
report amounts: `formatMoney(2900)` is `$29.00`. Pass `now` explicitly to
`formatRelativeTime` when rendering on the server so the output does not drift
between the server and the client.

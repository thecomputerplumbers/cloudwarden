import * as React from "react"
import { cn } from "cn"

import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

/**
 * One column of a `DataTable`. `cell` receives the whole row, so a column can
 * render anything — a status badge, a link, a formatted amount.
 */
export type DataTableColumn<Row> = {
  /** Stable identity for the column; also the React key. */
  id: string
  header: React.ReactNode
  cell: (row: Row, index: number) => React.ReactNode
  /** Right-align numbers so digits line up down the column. */
  align?: "start" | "end"
  /** Tailwind width utility, e.g. `w-32`. */
  width?: string
  /** Hides the column below the `sm` breakpoint. */
  hideOnMobile?: boolean
  headerClassName?: string
  cellClassName?: string
}

/**
 * A presentational table over a plain array. There is no sorting, filtering or
 * pagination engine here on purpose: those belong to the caller (a server
 * query, or TanStack Table if you want it client-side). What this owns is the
 * markup, the loading skeleton and the empty state, so every table in the app
 * agrees on those.
 *
 * ```tsx
 * <DataTable
 *   rows={invoices}
 *   getRowId={(invoice) => invoice.id}
 *   columns={[
 *     { id: "number", header: "Invoice", cell: (i) => i.number },
 *     { id: "total", header: "Total", align: "end", cell: (i) => format(i.total) },
 *   ]}
 * />
 * ```
 */
function DataTable<Row>({
  rows,
  columns,
  getRowId,
  onRowClick,
  loading = false,
  loadingRows = 5,
  empty,
  caption,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  rows: readonly Row[]
  columns: ReadonlyArray<DataTableColumn<Row>>
  getRowId: (row: Row, index: number) => string
  onRowClick?: (row: Row) => void
  loading?: boolean
  loadingRows?: number
  /** Shown in place of the body when there are no rows and nothing is loading. */
  empty?: React.ReactNode
  caption?: React.ReactNode
}) {
  const showEmpty = !loading && rows.length === 0 && empty != null

  return (
    <div data-slot="data-table" className={cn("w-full", className)} {...props}>
      <Table>
        {caption}
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={cn(
                  column.align === "end" && "text-right",
                  column.width,
                  column.hideOnMobile && "hidden sm:table-cell",
                  column.headerClassName
                )}
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            Array.from({ length: loadingRows }, (_, row) => (
              <TableRow key={`skeleton-${row}`}>
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(
                      column.hideOnMobile && "hidden sm:table-cell"
                    )}
                  >
                    <Skeleton className="h-4 w-full max-w-32" />
                  </TableCell>
                ))}
              </TableRow>
            ))}

          {showEmpty && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {empty}
              </TableCell>
            </TableRow>
          )}

          {!loading &&
            rows.map((row, index) => (
              <TableRow
                key={getRowId(row, index)}
                data-clickable={onRowClick ? true : undefined}
                className={cn(onRowClick && "cursor-pointer")}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(
                      column.align === "end" && "text-right tabular-nums",
                      column.hideOnMobile && "hidden sm:table-cell",
                      column.cellClassName
                    )}
                  >
                    {column.cell(row, index)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  )
}

export { DataTable }

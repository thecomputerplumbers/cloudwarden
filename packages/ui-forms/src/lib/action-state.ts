/**
 * The shape a server action returns to a form.
 *
 * Actions run on the server and communicate only through their return value,
 * so that value has to carry everything the form needs to re-render: whether
 * it succeeded, a message for the person, and which fields to mark invalid.
 * Keeping one shape for all of them means the field components can find their
 * own errors without every form wiring them up by hand.
 */

export type FieldErrors = Record<string, string[]>

export type FormState<Data = undefined> =
  | { status: "idle" }
  | { status: "success"; message?: string; data?: Data }
  | { status: "error"; message?: string; fieldErrors?: FieldErrors }

export const idleFormState: FormState<never> = { status: "idle" }

export function formSuccess<Data>(
  message?: string,
  data?: Data
): FormState<Data> {
  return { status: "success", message, data }
}

export function formError(
  message?: string,
  fieldErrors?: FieldErrors
): FormState<never> {
  return { status: "error", message, fieldErrors }
}

/** Reads the messages for one field out of a state, if there are any. */
export function errorsFor(
  state: FormState<unknown> | undefined,
  name: string | undefined
): string[] {
  if (!name || state?.status !== "error") return []
  return state.fieldErrors?.[name] ?? []
}

/**
 * Collapses validation issues into `FieldErrors`. The signature matches Zod's
 * `error.issues` and Valibot's, without this package depending on either:
 *
 * ```ts
 * const parsed = schema.safeParse(Object.fromEntries(formData))
 * if (!parsed.success) return formError("Check the form", fieldErrorsFromIssues(parsed.error.issues))
 * ```
 */
export function fieldErrorsFromIssues(
  issues: ReadonlyArray<{
    path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
    message: string
  }>
): FieldErrors {
  const errors: FieldErrors = {}

  for (const issue of issues) {
    const segment = issue.path?.[0]
    if (segment == null) continue
    const key = String(
      typeof segment === "object" && "key" in segment ? segment.key : segment
    )
    ;(errors[key] ??= []).push(issue.message)
  }

  return errors
}

/**
 * Trims a `FormData` value to a string, returning `undefined` for blanks so
 * optional fields do not arrive as empty strings.
 */
export function textField(data: FormData, name: string): string | undefined {
  const value = data.get(name)
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Checkboxes and switches are absent from `FormData` when unchecked. */
export function booleanField(data: FormData, name: string): boolean {
  const value = data.get(name)
  return value === "on" || value === "true" || value === "1"
}

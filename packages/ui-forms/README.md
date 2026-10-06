# @workspace/ui-forms

Forms built around server actions, not a client form library.

A server action communicates only through its return value, so that value has
to carry everything the form needs to re-render. This package fixes one shape
for it, and the fields find their own errors in it.

## The shape

```ts
type FormState<Data = undefined> =
  | { status: "idle" }
  | { status: "success"; message?: string; data?: Data }
  | {
      status: "error"
      message?: string
      fieldErrors?: Record<string, string[]>
    }
```

In the action:

```ts
const parsed = schema.safeParse(Object.fromEntries(formData))
if (!parsed.success) {
  return formError("Check the form", fieldErrorsFromIssues(parsed.error.issues))
}
return formSuccess("Saved")
```

`fieldErrorsFromIssues` matches Zod's and Valibot's `issues` shape without this
package depending on either.

## The form

```tsx
const [state, action] = useActionState(updateProfile, idleFormState)

<Form action={action} state={state}>
  <FormMessage />
  <FormFields>
    <TextField name="email" label="Email" type="email" required />
    <TextareaField name="bio" label="Bio" description="Shown on your profile." />
    <SwitchField name="notify" label="Email me about activity" />
  </FormFields>
  <FormActions>
    <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
  </FormActions>
</Form>
```

`<Form>` publishes the state through context, so no field is handed its own
errors — `TextField name="email"` picks up `fieldErrors.email` itself, wires
the `aria-describedby` and marks the control invalid.

`SubmitButton` reads `useFormStatus`, so it must be rendered _inside_ the
`<form>`. `FormPending` exposes the same flag as a render prop for anything
else that should go quiet during a submit.

## Components

| File               | Exports                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `form`             | `Form`, `FormFields`, `FormMessage`, `FormErrorSummary`, `FormActions`, `useFormState`, `useFieldErrors`                    |
| `fields`           | `TextField`, `TextareaField`, `SelectField`, `CheckboxField`, `SwitchField`, `useFieldParts`                                |
| `submit-button`    | `SubmitButton`, `FormPending`                                                                                               |
| `lib/action-state` | `FormState`, `idleFormState`, `formSuccess`, `formError`, `errorsFor`, `fieldErrorsFromIssues`, `textField`, `booleanField` |

For a control this package does not cover, `useFieldParts` gives you the same
ids, error lookup and `aria-describedby` wiring the built-in fields use.

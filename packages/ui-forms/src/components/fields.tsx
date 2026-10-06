"use client"

import * as React from "react"
import { cn } from "cn"

import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"

import { useFieldErrors } from "@workspace/ui-forms/components/form"

type FieldShellProps = {
  name: string
  label: React.ReactNode
  description?: React.ReactNode
  /** Overrides the errors the surrounding `<Form>` would supply. */
  errors?: string[]
  className?: string
}

/**
 * Shared plumbing for the field components: label, description, error and the
 * ids that tie them to the control. Exported because a one-off control still
 * wants the same wiring.
 */
function useFieldParts({
  name,
  errors,
}: Pick<FieldShellProps, "name" | "errors">) {
  const contextErrors = useFieldErrors(name)
  const messages = errors ?? contextErrors
  const id = React.useId()
  const controlId = `${id}-${name}`
  const descriptionId = `${controlId}-description`
  const errorId = `${controlId}-error`

  return {
    messages,
    invalid: messages.length > 0,
    controlId,
    descriptionId,
    errorId,
  }
}

function describedBy(
  hasDescription: boolean,
  descriptionId: string,
  invalid: boolean,
  errorId: string
) {
  const ids = [
    hasDescription ? descriptionId : undefined,
    invalid ? errorId : undefined,
  ].filter(Boolean)
  return ids.length > 0 ? ids.join(" ") : undefined
}

/** Single-line text, email, password, number, url — anything `<input>` does. */
function TextField({
  name,
  label,
  description,
  errors,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "name"> & FieldShellProps) {
  const parts = useFieldParts({ name, errors })

  return (
    <Field data-invalid={parts.invalid || undefined} className={className}>
      <FieldLabel htmlFor={parts.controlId}>{label}</FieldLabel>
      <Input
        id={parts.controlId}
        name={name}
        aria-invalid={parts.invalid || undefined}
        aria-describedby={describedBy(
          Boolean(description),
          parts.descriptionId,
          parts.invalid,
          parts.errorId
        )}
        {...props}
      />
      {description ? (
        <FieldDescription id={parts.descriptionId}>
          {description}
        </FieldDescription>
      ) : null}
      {parts.invalid ? (
        <FieldError id={parts.errorId}>
          {parts.messages.length === 1 ? (
            parts.messages[0]
          ) : (
            <ul className="ml-4 flex list-disc flex-col gap-1">
              {parts.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </FieldError>
      ) : null}
    </Field>
  )
}

function TextareaField({
  name,
  label,
  description,
  errors,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Textarea>, "name"> & FieldShellProps) {
  const parts = useFieldParts({ name, errors })

  return (
    <Field data-invalid={parts.invalid || undefined} className={className}>
      <FieldLabel htmlFor={parts.controlId}>{label}</FieldLabel>
      <Textarea
        id={parts.controlId}
        name={name}
        aria-invalid={parts.invalid || undefined}
        aria-describedby={describedBy(
          Boolean(description),
          parts.descriptionId,
          parts.invalid,
          parts.errorId
        )}
        {...props}
      />
      {description ? (
        <FieldDescription id={parts.descriptionId}>
          {description}
        </FieldDescription>
      ) : null}
      {parts.invalid ? (
        <FieldError id={parts.errorId}>{parts.messages.join(" ")}</FieldError>
      ) : null}
    </Field>
  )
}

export type SelectFieldOption = {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

/**
 * Base UI's Select posts its value through a hidden input, so this works in a
 * plain server-action form with no client state of its own.
 */
function SelectField({
  name,
  label,
  description,
  errors,
  className,
  options,
  placeholder = "Select…",
  triggerClassName,
  ...props
}: Omit<React.ComponentProps<typeof Select>, "name"> &
  FieldShellProps & {
    options: ReadonlyArray<SelectFieldOption>
    placeholder?: string
    triggerClassName?: string
  }) {
  const parts = useFieldParts({ name, errors })

  return (
    <Field data-invalid={parts.invalid || undefined} className={className}>
      <FieldLabel htmlFor={parts.controlId}>{label}</FieldLabel>
      <Select name={name} {...props}>
        <SelectTrigger
          id={parts.controlId}
          aria-invalid={parts.invalid || undefined}
          aria-describedby={describedBy(
            Boolean(description),
            parts.descriptionId,
            parts.invalid,
            parts.errorId
          )}
          className={cn("w-full", triggerClassName)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? (
        <FieldDescription id={parts.descriptionId}>
          {description}
        </FieldDescription>
      ) : null}
      {parts.invalid ? (
        <FieldError id={parts.errorId}>{parts.messages.join(" ")}</FieldError>
      ) : null}
    </Field>
  )
}

/** Checkbox with its label to the right and the description beneath. */
function CheckboxField({
  name,
  label,
  description,
  errors,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Checkbox>, "name"> & FieldShellProps) {
  const parts = useFieldParts({ name, errors })

  return (
    <Field
      orientation="horizontal"
      data-invalid={parts.invalid || undefined}
      className={className}
    >
      <Checkbox
        id={parts.controlId}
        name={name}
        aria-invalid={parts.invalid || undefined}
        aria-describedby={describedBy(
          Boolean(description),
          parts.descriptionId,
          parts.invalid,
          parts.errorId
        )}
        {...props}
      />
      <FieldContent>
        <FieldLabel htmlFor={parts.controlId} className="font-normal">
          {label}
        </FieldLabel>
        {description ? (
          <FieldDescription id={parts.descriptionId}>
            {description}
          </FieldDescription>
        ) : null}
        {parts.invalid ? (
          <FieldError id={parts.errorId}>{parts.messages.join(" ")}</FieldError>
        ) : null}
      </FieldContent>
    </Field>
  )
}

/** A setting you flip: label on the left, switch pinned to the right. */
function SwitchField({
  name,
  label,
  description,
  errors,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Switch>, "name"> & FieldShellProps) {
  const parts = useFieldParts({ name, errors })

  return (
    <Field
      orientation="horizontal"
      data-invalid={parts.invalid || undefined}
      className={cn("justify-between", className)}
    >
      <FieldContent>
        <FieldLabel htmlFor={parts.controlId} className="font-normal">
          {label}
        </FieldLabel>
        {description ? (
          <FieldDescription id={parts.descriptionId}>
            {description}
          </FieldDescription>
        ) : null}
        {parts.invalid ? (
          <FieldError id={parts.errorId}>{parts.messages.join(" ")}</FieldError>
        ) : null}
      </FieldContent>
      <Switch
        id={parts.controlId}
        name={name}
        aria-describedby={description ? parts.descriptionId : undefined}
        {...props}
      />
    </Field>
  )
}

export {
  CheckboxField,
  SelectField,
  SwitchField,
  TextareaField,
  TextField,
  useFieldParts,
}

"use client";

/**
 * One spec-driven argument field.
 *
 * The recursion is the point: a `vec<StreamInput>` renders a repeatable group
 * of address/int/bool fields, an `option<address>` renders a presence toggle
 * plus an address field, and a tagged union renders a case selector plus that
 * case's payload. Adding a new contract struct or entrypoint does not require
 * a new hand-written form.
 */
import { useId } from "react";
import {
  type ContractSpec,
  type TypeRef,
  formatTypeRef,
  getEnumSpec,
  getStructSpec,
  getUnionSpec,
  isOptionType,
  isResultType,
  isVecType,
} from "@/lib/tx-builder/spec";
import {
  emptyValue,
  isStructValue,
  isUnionValue,
  type TxValue,
} from "@/lib/tx-builder/values";

export interface ArgFieldProps {
  spec: ContractSpec;
  type: TypeRef;
  value: TxValue;
  onChange: (value: TxValue) => void;
  label: string;
  path: string;
  walletAddress?: string | null;
}

function fieldsetStyle(): React.CSSProperties {
  return {
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: "10px 12px 12px",
    margin: "10px 0",
    minWidth: 0,
  };
}

function legendStyle(): React.CSSProperties {
  return {
    padding: "0 6px",
    color: "var(--accent2)",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  };
}

export default function ArgField({
  spec,
  type,
  value,
  onChange,
  label,
  path,
  walletAddress,
}: ArgFieldProps) {
  const id = useId();

  if (typeof type === "string") {
    const struct = getStructSpec(type);
    if (struct) {
      const object = isStructValue(value) ? value : {};
      return (
        <fieldset style={fieldsetStyle()}>
          <legend style={legendStyle()}>
            {label} <span className="mono">({type})</span>
          </legend>
          {struct.fields.map((field) => (
            <ArgField
              key={field.name}
              spec={spec}
              type={field.type}
              value={object[field.name] ?? emptyValue(spec, field.type)}
              onChange={(next) => onChange({ ...object, [field.name]: next })}
              label={field.name}
              path={`${path}.${field.name}`}
              walletAddress={walletAddress}
            />
          ))}
        </fieldset>
      );
    }

    const enumSpec = getEnumSpec(type);
    if (enumSpec) {
      return (
        <div>
          <label htmlFor={id}>
            {label} <span className="mono">({type})</span>
          </label>
          <select
            id={id}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          >
            {enumSpec.cases.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      );
    }

    const union = getUnionSpec(type);
    if (union) {
      const selected = isUnionValue(value)
        ? value
        : {
            variant: union.cases[0]?.name ?? "",
            values: (union.cases[0]?.types ?? []).map((caseType) =>
              emptyValue(spec, caseType),
            ),
          };
      const chosen = union.cases.find((entry) => entry.name === selected.variant);
      return (
        <fieldset style={fieldsetStyle()}>
          <legend style={legendStyle()}>
            {label} <span className="mono">({type})</span>
          </legend>
          <label htmlFor={`${id}-variant`}>Case</label>
          <select
            id={`${id}-variant`}
            value={selected.variant}
            onChange={(event) => {
              const next = union.cases.find((entry) => entry.name === event.target.value);
              onChange({
                variant: event.target.value,
                values: (next?.types ?? []).map((caseType) => emptyValue(spec, caseType)),
              });
            }}
          >
            {union.cases.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
          {chosen?.types.map((caseType, index) => (
            <ArgField
              key={`${selected.variant}-${index}`}
              spec={spec}
              type={caseType}
              value={selected.values[index] ?? emptyValue(spec, caseType)}
              onChange={(next) => {
                const values = [...selected.values];
                values[index] = next;
                onChange({ ...selected, values });
              }}
              label={`${selected.variant}[${index}]`}
              path={`${path}.${selected.variant}[${index}]`}
              walletAddress={walletAddress}
            />
          ))}
        </fieldset>
      );
    }

    return (
      <PrimitiveField
        type={type}
        value={value}
        onChange={onChange}
        label={label}
        path={path}
        walletAddress={walletAddress}
      />
    );
  }

  if (isVecType(type)) {
    const items = Array.isArray(value) ? value : [];
    return (
      <fieldset style={fieldsetStyle()}>
        <legend style={legendStyle()}>
          {label} <span className="mono">({formatTypeRef(type)})</span>
        </legend>
        {items.length === 0 && <p className="muted">No items.</p>}
        {items.map((item, index) => (
          <div
            key={`${path}-${index}`}
            style={{
              borderLeft: "2px solid var(--line-light)",
              paddingLeft: 10,
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span className="muted mono">item {index}</span>
              <button
                type="button"
                className="copy-btn"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
            <ArgField
              spec={spec}
              type={type.vec}
              value={item}
              onChange={(next) => {
                const updated = [...items];
                updated[index] = next;
                onChange(updated);
              }}
              label={`Item ${index}`}
              path={`${path}[${index}]`}
              walletAddress={walletAddress}
            />
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onChange([...items, emptyValue(spec, type.vec)])}
        >
          + Add item
        </button>
      </fieldset>
    );
  }

  if (isOptionType(type)) {
    const present = value !== null && value !== undefined;
    const optionId = `${id}-present`;
    return (
      <div>
        <label className="sched-check" htmlFor={optionId}>
          <input
            id={optionId}
            type="checkbox"
            checked={present}
            onChange={(event) =>
              onChange(event.target.checked ? emptyValue(spec, type.option) : null)
            }
          />
          <span>
            Include {label} <span className="mono">({formatTypeRef(type)})</span>
          </span>
        </label>
        {present && (
          <ArgField
            spec={spec}
            type={type.option}
            value={value}
            onChange={onChange}
            label={label}
            path={path}
            walletAddress={walletAddress}
          />
        )}
      </div>
    );
  }

  if (isResultType(type)) {
    const selected = isUnionValue(value)
      ? value
      : { variant: "Ok", values: [emptyValue(spec, type.result.ok)] };
    const chosen = selected.variant === "Err" ? type.result.err : type.result.ok;
    return (
      <fieldset style={fieldsetStyle()}>
        <legend style={legendStyle()}>
          {label} <span className="mono">({formatTypeRef(type)})</span>
        </legend>
        <ArgField
          spec={spec}
          type={chosen}
          value={selected.values[0] ?? emptyValue(spec, chosen)}
          onChange={(next) => onChange({ ...selected, values: [next] })}
          label={selected.variant}
          path={`${path}.${selected.variant}`}
          walletAddress={walletAddress}
        />
      </fieldset>
    );
  }

  return <p className="err">{path}: unsupported type {formatTypeRef(type)}</p>;
}

function PrimitiveField({
  type,
  value,
  onChange,
  label,
  path,
  walletAddress,
}: {
  type: string;
  value: TxValue;
  onChange: (value: TxValue) => void;
  label: string;
  path: string;
  walletAddress?: string | null;
}) {
  const id = useId();

  if (type === "bool") {
    return (
      <label className="sched-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  }

  const textValue = typeof value === "string" ? value : "";
  const placeholder =
    type === "address"
      ? "G... account or C... contract"
      : type === "bytes32"
        ? "64 hex characters"
        : type === "bytes64"
          ? "128 hex characters"
          : type === "u32"
            ? "0 to 4294967295"
            : type === "u64"
              ? "Unsigned 64-bit integer"
              : type === "i128"
                ? "Signed 128-bit integer"
                : type;

  return (
    <div>
      <label htmlFor={id}>
        {label} <span className="mono">({type})</span>
      </label>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          id={id}
          type="text"
          inputMode={
            type === "u32" || type === "u64" || type === "i128" ? "numeric" : "text"
          }
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          value={textValue}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={`${id}-path`}
        />
        {type === "address" && walletAddress && (
          <button
            type="button"
            className="copy-btn"
            onClick={() => onChange(walletAddress)}
            title="Use the connected wallet address"
          >
            Use wallet
          </button>
        )}
      </div>
      <span id={`${id}-path`} className="sr-only">
        {path}
      </span>
    </div>
  );
}

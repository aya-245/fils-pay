const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new RangeError(`sqlFilter: unsafe SQL identifier "${name}"`);
  return name;
}

/** Column names are interpolated, so they must be plain identifiers; values are always bound parameters. */
export function buildWhere(
  filters: Record<string, unknown>,
): { clause: string; values: unknown[]; paramOffset: number } {
  const parts: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [col, val] of Object.entries(filters)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      values.push(val);
      parts.push(`${assertIdent(col)} = ANY($${idx}::uuid[])`);
      idx++;
    } else {
      values.push(val);
      parts.push(`${assertIdent(col)} = $${idx}`);
      idx++;
    }
  }
  const clause = parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  return { clause, values, paramOffset: idx };
}

export function buildDelete(
  table: string,
  filters: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const { clause, values } = buildWhere(filters);
  // Refuse an unfiltered DELETE: an empty/ignored filter would wipe the table.
  if (clause === "") throw new RangeError("sqlFilter: refusing DELETE without a filter");
  return { text: `DELETE FROM ${assertIdent(table)} ${clause}`.trim(), values };
}

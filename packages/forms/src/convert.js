// Exporting a form's answers as CSV (one row per response).

const cell = (v) => {
  const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// questions: the form's current questions; responses: from readResponses.
// Questions that were removed since someone answered still get a column.
export function responsesCsv (questions, responses) {
  const cols = questions.map((q) => ({ id: q.id, title: q.title || 'Untitled question' }))
  for (const r of responses) {
    for (const [id, title] of Object.entries(r.questions)) if (!cols.some((c) => c.id === id) && id in r.answers) cols.push({ id, title: title || 'Removed question' })
  }
  const rows = [['Submitted', 'Name', ...cols.map((c) => c.title)]]
  for (const r of responses) rows.push([new Date(r.at).toISOString(), r.name, ...cols.map((c) => r.answers[c.id])])
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

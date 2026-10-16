// Ready-made workbooks for "New from a template".

import { initSheets, sheetList, setCell, styleRange, setWidth } from './model.js'

// rows: arrays of inputs (formulas start with =), written from A1.
function sheet (ydoc, { name, rows, widths = [], header = true, currency = [], total = null }) {
  ydoc.transact(() => {
    initSheets(ydoc, { name })
    const id = sheetList(ydoc)[0].id
    rows.forEach((row, r) => row.forEach((input, c) => { if (input !== '') setCell(ydoc, id, r, c, input) }))
    widths.forEach((w, c) => { if (w) setWidth(ydoc, id, c, w) })
    if (header) styleRange(ydoc, id, { r0: 0, c0: 0, r1: 0, c1: rows[0].length - 1 }, { b: true, bg: '#eef2fa' })
    for (const c of currency) styleRange(ydoc, id, { r0: 1, c0: c, r1: rows.length - 1, c1: c }, { nf: 'currency' })
    if (total != null) styleRange(ydoc, id, { r0: total, c0: 0, r1: total, c1: rows[0].length - 1 }, { b: true })
  })
}

export const sheetTemplates = [
  {
    id: 'sheet.budget',
    name: 'Monthly budget',
    description: 'Planned against actual, with the difference worked out',
    build: (ydoc) => {
      const items = ['Rent or mortgage', 'Groceries', 'Transport', 'Utilities', 'Phone and internet', 'Eating out', 'Savings', 'Other']
      const rows = [['Category', 'Planned', 'Actual', 'Difference'], ...items.map((name, i) => [name, '', '', `=B${i + 2}-C${i + 2}`])]
      const last = rows.length
      rows.push(['Total', `=SUM(B2:B${last})`, `=SUM(C2:C${last})`, `=SUM(D2:D${last})`])
      sheet(ydoc, { name: 'Budget', rows, widths: [180, 110, 110, 110], currency: [1, 2, 3], total: rows.length - 1 })
    }
  },
  {
    id: 'sheet.shared-costs',
    name: 'Shared costs',
    description: 'Who paid for what, and what each person has spent',
    build: (ydoc) => {
      const rows = [
        ['Date', 'What', 'Paid by', 'Amount', '', 'Person', 'Spent'],
        ['', '', '', '', '', 'Person 1', '=SUMIF(C2:C40,F2,D2:D40)'],
        ['', '', '', '', '', 'Person 2', '=SUMIF(C2:C40,F3,D2:D40)'],
        ['', '', '', '', '', 'Person 3', '=SUMIF(C2:C40,F4,D2:D40)'],
        ['', '', '', '', '', 'Total', '=SUM(D2:D40)']
      ]
      sheet(ydoc, { name: 'Costs', rows, widths: [100, 200, 120, 100, 30, 120, 100], currency: [3, 6] })
    }
  },
  {
    id: 'sheet.tracker',
    name: 'Tracker',
    description: 'Items with an owner, status and due date',
    build: (ydoc) => sheet(ydoc, { name: 'Tracker', rows: [['Item', 'Owner', 'Status', 'Due', 'Notes']], widths: [220, 120, 110, 110, 260] })
  }
]

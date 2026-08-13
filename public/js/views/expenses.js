import { api, session } from '../api.js';
import { buildForm, closeModal, confirmDialog, date, h, money, openModal, stat, table, toast, today } from '../ui.js';

const SUGGESTED_CATEGORIES = ['Rent', 'Electricity', 'Wifi/Internet', 'Staff', 'Maintenance', 'Supplies', 'Marketing'];

function openExpenseForm({ expense, categories, onSaved }) {
  const editing = Boolean(expense);
  const categoryOptions = [...new Set([...SUGGESTED_CATEGORIES, ...categories])];

  const form = buildForm(
    [
      {
        name: 'category',
        label: 'Category',
        required: true,
        full: true,
        list: 'expense-categories',
        value: expense?.category,
        placeholder: 'Rent, Electricity, Staff…',
      },
      { name: 'amount', label: 'Amount', type: 'number', required: true, min: 0.01, step: '0.01', value: expense?.amount },
      { name: 'spent_on', label: 'Spent on', type: 'date', value: expense?.spent_on || today() },
      {
        name: 'method',
        label: 'Method',
        type: 'select',
        value: expense?.method || 'cash',
        options: ['cash', 'card', 'upi', 'bank', 'online'].map((v) => ({ value: v, label: v.toUpperCase() })),
      },
      { name: 'vendor', label: 'Vendor / paid to', value: expense?.vendor },
      { name: 'note', label: 'Note', full: true, value: expense?.note },
    ],
    {
      submitLabel: editing ? 'Save' : 'Log expense',
      onSubmit: async (values) => {
        if (editing) await api.updateExpense(expense.id, values);
        else await api.createExpense(values);
        closeModal();
        toast(editing ? 'Expense updated' : 'Expense logged');
        await onSaved?.();
      },
    },
  );

  openModal({
    title: editing ? 'Edit expense' : 'Log an expense',
    body: h('div', {}, h('datalist', { id: 'expense-categories' }, categoryOptions.map((c) => h('option', { value: c }))), form),
  });
}

export async function renderExpenses({ reload }) {
  const [{ items, categories, totals }, summary] = await Promise.all([api.expenses({}), api.expenseSummary({})]);
  const canManage = session.managesBilling;

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'grid cols-4' },
      stat('Collected this month', money(summary.collected)),
      stat('Spent this month', money(summary.spent)),
      stat('Net', money(summary.net), null, { accent: summary.net >= 0 }),
      canManage
        ? h(
            'div',
            { class: 'card', style: 'display:flex;align-items:center;justify-content:center' },
            h('button', { class: 'btn primary', onclick: () => openExpenseForm({ categories, onSaved: reload }) }, '＋ Log expense'),
          )
        : h('div', {}),
    ),
    summary.by_category.length
      ? h(
          'div',
          { class: 'card' },
          h('h3', {}, 'By category, this month'),
          h(
            'div',
            { class: 'pill-row' },
            summary.by_category.map((c) => h('span', { class: 'badge grey' }, `${c.category}: ${money(c.total)}`)),
          ),
        )
      : null,
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      table(
        [
          { label: 'Date', render: (row) => date(row.spent_on) },
          { label: 'Category', render: (row) => row.category },
          { label: 'Vendor', render: (row) => row.vendor || '—' },
          { label: 'Method', render: (row) => h('span', { class: 'badge grey' }, row.method.toUpperCase()) },
          { label: 'Amount', align: 'right', render: (row) => money(row.amount) },
          {
            label: '',
            render: (row) =>
              canManage
                ? h(
                    'div',
                    { class: 'row', style: 'gap:6px' },
                    h('button', { class: 'btn sm', onclick: () => openExpenseForm({ expense: row, categories, onSaved: reload }) }, 'Edit'),
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: () =>
                          confirmDialog({
                            title: 'Delete this expense?',
                            message: `${row.category} — ${money(row.amount)} on ${date(row.spent_on)}.`,
                            confirmLabel: 'Delete',
                            danger: true,
                            onConfirm: async () => {
                              await api.deleteExpense(row.id);
                              toast('Expense deleted');
                              await reload();
                            },
                          }),
                      },
                      'Delete',
                    ),
                  )
                : null,
          },
        ],
        items,
        { empty: 'Nothing logged yet' },
      ),
    ),
    h('p', { class: 'muted', style: 'font-size:12px' }, `${totals.count} expenses, ${money(totals.total)} total.`),
  );
}

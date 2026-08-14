import { api } from '../api.js';
import {
  addDays,
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  fullName,
  h,
  money,
  openModal,
  stat,
  today,
  toast,
} from '../ui.js';
import { datalist, memberOptions, openPaymentForm, resolveMember } from './forms.js';
import { t } from '../vertical.js';

/**
 * The seat map — SeatBook's centrepiece. No drag-drop, no canvas: a seat is
 * (zone_id, row_label, col_index), and the layout engine is just a CSS grid
 * per row with each tile set to `grid-column: col_index` — skipping a column
 * *is* the aisle.
 */

const STATE_LABEL = {
  occupied: 'Occupied',
  expiring: 'Expiring soon',
  expired: 'Expired',
  dues: 'Dues pending',
  frozen: 'On hold (frozen)',
};

/* --------------------------------------------------------- bulk setup --- */

/**
 * Pure: turns the bulk-setup form's values into the flat seat list the
 * server expects. Shared between the live preview and the actual submit, the
 * same trick openMembershipForm uses to keep its amount field in sync.
 */
function planSeats(values) {
  const rowsSpec = String(values.rows || '').trim();
  const perRow = Math.max(Number(values.per_row) || 0, 0);
  const startAt = Number.isFinite(Number(values.start_at)) ? Number(values.start_at) : 1;
  const continuous = values.numbering === 'continuous';

  let rowLabels = [];
  if (/^[A-Za-z]-[A-Za-z]$/.test(rowsSpec)) {
    const [from, to] = rowsSpec.split('-').map((c) => c.toUpperCase().charCodeAt(0));
    for (let c = from; c <= to; c += 1) rowLabels.push(String.fromCharCode(c));
  } else if (rowsSpec) {
    rowLabels = rowsSpec.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (!rowLabels.length || !perRow) return [];

  const seats = [];
  let counter = startAt;
  for (const row of rowLabels) {
    if (!continuous) counter = startAt;
    for (let col = 1; col <= perRow; col += 1) {
      seats.push({ code: `${row}-${counter}`, row_label: row, col_index: col });
      counter += 1;
    }
  }
  return seats;
}

async function openSeatBulkForm({ zones, onSaved }) {
  const preview = h('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' }, 'Fill in the rows and count above to preview.');

  const fields = [
    {
      name: 'zone_id',
      label: 'Zone',
      type: 'select',
      full: true,
      options: [
        { value: '', label: 'New zone (named below)' },
        ...zones.map((z) => ({ value: z.id, label: z.name })),
      ],
    },
    { name: 'zone_name', label: 'New zone name', placeholder: 'Ground Floor', value: zones.length ? '' : 'Ground Floor' },
    { name: 'rows', label: 'Row labels', placeholder: 'A-F  or  A,B,C', hint: 'A range like "A-F", or a comma list.' },
    { name: 'per_row', label: 'Seats per row', type: 'number', min: 1, value: 10 },
    { name: 'start_at', label: 'Numbering starts at', type: 'number', value: 1 },
    {
      name: 'numbering',
      label: 'Numbering',
      type: 'select',
      options: [
        { value: 'per_row', label: 'Restart each row (A-1, A-2… B-1, B-2…)' },
        { value: 'continuous', label: 'Continue across rows (A-1, A-2… B-11, B-12…)' },
      ],
    },
  ];

  const form = buildForm(fields, {
    submitLabel: 'Create seats',
    onSubmit: async (values) => {
      const seats = planSeats(values);
      if (!seats.length) {
        toast('Add row labels and a seat count first', 'error');
        return;
      }
      let zoneId = values.zone_id ? Number(values.zone_id) : null;
      if (!zoneId && values.zone_name?.trim()) {
        const zone = await api.createSeatZone({ name: values.zone_name.trim() });
        zoneId = zone.id;
      }
      const res = await api.bulkCreateSeats({ zone_id: zoneId, seats });
      closeModal();
      toast(`${res.created} seats created`);
      await onSaved?.();
    },
  });

  const grid = form.querySelector('.form-grid');
  grid.append(preview);

  const syncPreview = () => {
    const values = Object.fromEntries(['rows', 'per_row', 'start_at', 'numbering'].map((n) => [n, form.querySelector(`[name=${n}]`)?.value]));
    const seats = planSeats(values);
    if (!seats.length) {
      preview.textContent = 'Fill in the rows and count above to preview.';
      return;
    }
    const sample = seats.slice(0, 8).map((s) => s.code).join(', ');
    preview.textContent = `${seats.length} seats: ${sample}${seats.length > 8 ? '…' : ''}`;
  };
  ['rows', 'per_row', 'start_at', 'numbering'].forEach((name) => {
    form.querySelector(`[name=${name}]`)?.addEventListener('input', syncPreview);
    form.querySelector(`[name=${name}]`)?.addEventListener('change', syncPreview);
  });
  syncPreview();

  openModal({ title: 'Set up your hall', wide: true, body: form });
}

/* -------------------------------------------------------------- assign --- */

async function openSeatAssignForm({ seat, sessionId, shiftName, onSaved }) {
  const [{ items: allPlans }, options] = await Promise.all([api.plans({ active: 'true' }), memberOptions()]);
  // A plan locked to a different shift would be rejected server-side anyway —
  // don't offer it here.
  const plans = allPlans.filter((p) => !p.session_id || p.session_id === sessionId);

  const fields = [
    { name: 'member', label: 'Student', required: true, full: true, list: 'member-options', placeholder: 'Search by code or name' },
    {
      name: 'plan_id',
      label: 'Pass',
      type: 'select',
      full: true,
      value: plans[0]?.id ?? '',
      options: [
        { value: '', label: 'No pass — just hold the seat' },
        ...plans.map((p) => ({ value: p.id, label: `${p.name} — ${money(p.price)} / ${p.duration_days} days` })),
      ],
    },
    { name: 'start_date', label: 'Starts on', type: 'date', value: today() },
    {
      name: 'end_date',
      label: 'Holds until',
      type: 'date',
      value: addDays(today(), 30),
      hint: 'Set automatically once a pass is picked — edit freely for a manual hold with no pass.',
    },
    { name: 'discount', label: 'Discount', type: 'number', value: 0, min: 0, step: '0.01' },
    { name: 'payment_amount', label: 'Amount collected now', type: 'number', min: 0, step: '0.01', value: plans[0]?.price ?? 0 },
    {
      name: 'payment_method',
      label: 'Payment method',
      type: 'select',
      value: 'cash',
      options: ['cash', 'card', 'upi', 'bank', 'online'].map((v) => ({ value: v, label: v.toUpperCase() })),
    },
    { name: 'reference', label: 'Reference / receipt no.' },
    { name: 'note', label: 'Note', full: true },
  ];

  const form = buildForm(fields, {
    submitLabel: `Assign ${seat.code}`,
    onSubmit: async (values) => {
      const memberId = resolveMember(options, values.member);
      if (!memberId) {
        toast('Pick a student from the list', 'error');
        return;
      }

      if (values.plan_id) {
        // Selling a pass with a seat in the same breath: the seat is
        // allocated inside the sale's own transaction server-side, so a
        // failed sale can never leave an orphan allocation.
        const sub = await api.createSubscription({
          member_id: memberId,
          plan_id: values.plan_id,
          session_id: sessionId,
          seat_id: seat.id,
          start_date: values.start_date || undefined,
          discount: values.discount || 0,
          payment_amount: values.payment_amount || undefined,
          payment_method: values.payment_method,
          reference: values.reference || undefined,
          note: values.note || undefined,
        });
        closeModal();
        toast(`${seat.code} assigned — ${sub.plan_name} activated`);
      } else {
        await api.allocateSeat(seat.id, {
          session_id: sessionId,
          member_id: memberId,
          start_date: values.start_date || today(),
          end_date: values.end_date,
          note: values.note || undefined,
        });
        closeModal();
        toast(`${seat.code} assigned`);
      }
      await onSaved?.();
    },
  });

  const planSelect = form.querySelector('[name=plan_id]');
  const endInput = form.querySelector('[name=end_date]');
  const startInput = form.querySelector('[name=start_date]');
  const amountInput = form.querySelector('[name=payment_amount]');
  const discountInput = form.querySelector('[name=discount]');
  const sync = () => {
    const plan = plans.find((p) => String(p.id) === planSelect.value);
    if (!plan) return;
    endInput.value = addDays(startInput.value || today(), plan.duration_days);
    amountInput.value = Math.max(plan.price - Number(discountInput.value || 0), 0);
  };
  planSelect.addEventListener('change', sync);
  startInput.addEventListener('change', sync);
  discountInput.addEventListener('input', sync);

  openModal({
    title: `Assign seat ${seat.code} — ${shiftName}`,
    wide: true,
    body: h('div', {}, datalist('member-options', options), form),
  });
}

/**
 * The reverse of openSeatAssignForm: started from a known member (e.g. their
 * profile page) rather than from a seat tile. Staff pick a shift, then a
 * vacant seat within it, computed client-side from the same seat map the
 * seat screen uses — no separate "vacant seats for shift X" endpoint needed.
 */
export async function openMemberSeatAssignForm({ member, onSaved }) {
  const [map, { items: allPlans }] = await Promise.all([api.seatMap({}), api.plans({ active: 'true' })]);

  if (!map.shifts.length) {
    toast('Set up shifts before assigning a seat', 'error');
    return;
  }

  const occupiedKeys = new Set(map.occupancy.map((o) => `${o.seat_id}:${o.session_id}`));
  const availableSeats = map.seats.filter((s) => s.status === 'available');
  const vacantSeatsFor = (sessionId) =>
    availableSeats.filter((seat) => !occupiedKeys.has(`${seat.id}:${sessionId}`));

  const initialShift = map.shifts.find((s) => vacantSeatsFor(s.id).length > 0) || map.shifts[0];

  const fields = [
    {
      name: 'session_id',
      label: t('shift'),
      type: 'select',
      full: true,
      value: initialShift?.id ?? '',
      options: map.shifts.map((s) => ({ value: s.id, label: `${s.name} (${vacantSeatsFor(s.id).length} vacant)` })),
    },
    {
      name: 'seat_id',
      label: 'Seat',
      type: 'select',
      full: true,
      options: vacantSeatsFor(initialShift?.id).map((s) => ({ value: s.id, label: s.code })),
    },
    {
      name: 'plan_id',
      label: 'Pass',
      type: 'select',
      full: true,
      options: [{ value: '', label: 'No pass — just hold the seat' }],
    },
    { name: 'start_date', label: 'Starts on', type: 'date', value: today() },
    {
      name: 'end_date',
      label: 'Holds until',
      type: 'date',
      value: addDays(today(), 30),
      hint: 'Set automatically once a pass is picked — edit freely for a manual hold with no pass.',
    },
    { name: 'discount', label: 'Discount', type: 'number', value: 0, min: 0, step: '0.01' },
    { name: 'payment_amount', label: 'Amount collected now', type: 'number', min: 0, step: '0.01', value: 0 },
    {
      name: 'payment_method',
      label: 'Payment method',
      type: 'select',
      value: 'cash',
      options: ['cash', 'card', 'upi', 'bank', 'online'].map((v) => ({ value: v, label: v.toUpperCase() })),
    },
    { name: 'reference', label: 'Reference / receipt no.' },
    { name: 'note', label: 'Note', full: true },
  ];

  const form = buildForm(fields, {
    submitLabel: 'Assign seat',
    onSubmit: async (values) => {
      const seatId = Number(values.seat_id);
      const sessionId = Number(values.session_id);
      if (!seatId) {
        toast('Pick a vacant seat first', 'error');
        return;
      }

      if (values.plan_id) {
        const sub = await api.createSubscription({
          member_id: member.id,
          plan_id: values.plan_id,
          session_id: sessionId,
          seat_id: seatId,
          start_date: values.start_date || undefined,
          discount: values.discount || 0,
          payment_amount: values.payment_amount || undefined,
          payment_method: values.payment_method,
          reference: values.reference || undefined,
          note: values.note || undefined,
        });
        closeModal();
        toast(`Seat assigned — ${sub.plan_name} activated`);
      } else {
        await api.allocateSeat(seatId, {
          session_id: sessionId,
          member_id: member.id,
          start_date: values.start_date || today(),
          end_date: values.end_date,
          note: values.note || undefined,
        });
        closeModal();
        toast('Seat assigned');
      }
      await onSaved?.();
    },
  });

  const sessionSelect = form.querySelector('[name=session_id]');
  const seatSelect = form.querySelector('[name=seat_id]');
  const planSelect = form.querySelector('[name=plan_id]');
  const endInput = form.querySelector('[name=end_date]');
  const startInput = form.querySelector('[name=start_date]');
  const amountInput = form.querySelector('[name=payment_amount]');
  const discountInput = form.querySelector('[name=discount]');

  let plans = [];
  const syncPlans = () => {
    const sessionId = Number(sessionSelect.value);
    plans = allPlans.filter((p) => !p.session_id || p.session_id === sessionId);
    clear(planSelect);
    planSelect.append(
      h('option', { value: '' }, 'No pass — just hold the seat'),
      ...plans.map((p) => h('option', { value: p.id }, `${p.name} — ${money(p.price)} / ${p.duration_days} days`)),
    );
  };

  const syncSeats = () => {
    const sessionId = Number(sessionSelect.value);
    const vacant = vacantSeatsFor(sessionId);
    clear(seatSelect);
    seatSelect.append(...vacant.map((s) => h('option', { value: s.id }, s.code)));
    syncPlans();
  };

  const syncAmount = () => {
    const plan = plans.find((p) => String(p.id) === planSelect.value);
    if (!plan) return;
    endInput.value = addDays(startInput.value || today(), plan.duration_days);
    amountInput.value = Math.max(plan.price - Number(discountInput.value || 0), 0);
  };

  sessionSelect.addEventListener('change', syncSeats);
  planSelect.addEventListener('change', syncAmount);
  startInput.addEventListener('change', syncAmount);
  discountInput.addEventListener('input', syncAmount);

  syncSeats();

  openModal({
    title: `Assign seat — ${fullName(member)}`,
    wide: true,
    body: form,
  });
}

/* --------------------------------------------------------------- detail --- */

function openSeatDetailModal({ cell, seat, sessionId, shiftName, onSaved, navigate }) {
  const body = h(
    'div',
    {},
    h('p', {}, h('strong', {}, cell.member_name), ` (${cell.member_code})`),
    h('p', { class: 'muted' }, `Seat ${seat.code} — ${shiftName}, until ${cell.end_date}`),
    h('p', { class: 'muted' }, STATE_LABEL[cell.state] || cell.state),
    cell.balance_due > 0 ? h('p', {}, h('strong', {}, `Dues: ${money(cell.balance_due)}`)) : null,
  );

  const actions = [
    h('button', { class: 'btn ghost', onclick: () => { closeModal(); navigate(`/members/${cell.member_id}`); } }, 'Open profile'),
    h(
      'button',
      {
        class: 'btn ghost',
        onclick: async () => {
          try {
            await api.sendWhatsAppReminder({ member_id: cell.member_id });
            toast('Reminder sent');
          } catch (err) {
            toast(err.message || 'Could not send the reminder', 'error');
          }
        },
      },
      '💬 Remind',
    ),
    cell.balance_due > 0
      ? h(
          'button',
          {
            class: 'btn ghost',
            onclick: () => {
              closeModal();
              openPaymentForm({
                member: { id: cell.member_id, first_name: cell.member_name },
                subscriptions: cell.subscription_id
                  ? [{ id: cell.subscription_id, plan_name: 'this pass', start_date: '', end_date: cell.end_date, status: 'active' }]
                  : [],
                onSaved,
              });
            },
          },
          '💳 Collect',
        )
      : null,
    h(
      'button',
      {
        class: 'btn ghost',
        onclick: () => {
          closeModal();
          openTransferForm({ seat, sessionId, shiftName, onSaved });
        },
      },
      '⇄ Transfer',
    ),
    h(
      'button',
      {
        class: 'btn danger',
        onclick: () => {
          confirmDialog({
            title: 'Vacate this seat?',
            message: `${cell.member_name} will lose seat ${seat.code} for the ${shiftName} shift. This does not cancel their pass.`,
            confirmLabel: 'Vacate',
            danger: true,
            onConfirm: async () => {
              await api.releaseSeat(seat.id, { session_id: sessionId, reason: 'manual' });
              toast(`${seat.code} vacated`);
              await onSaved?.();
            },
          });
        },
      },
      'Vacate',
    ),
  ];

  openModal({ title: `Seat ${seat.code}`, body, footer: actions });
}

async function openTransferForm({ seat, sessionId, shiftName, onSaved }) {
  const { items: seats } = await api.seats({ status: 'available' });
  const targets = seats.filter((s) => s.id !== seat.id);

  const form = buildForm(
    [
      {
        name: 'to_seat_id',
        label: 'Move to seat',
        type: 'select',
        required: true,
        full: true,
        options: targets.map((s) => ({ value: s.id, label: s.code })),
      },
    ],
    {
      submitLabel: 'Transfer',
      onSubmit: async (values) => {
        await api.transferSeat(seat.id, { session_id: sessionId, to_seat_id: values.to_seat_id });
        closeModal();
        toast('Seat transferred');
        await onSaved?.();
      },
    },
  );

  openModal({ title: `Transfer from ${seat.code} — ${shiftName}`, body: form });
}

/* ------------------------------------------------------------------ edit --- */

async function openSeatEditForm({ seat, zones, onSaved }) {
  const form = buildForm(
    [
      { name: 'code', label: 'Code', required: true, value: seat.code },
      {
        name: 'zone_id',
        label: 'Zone',
        type: 'select',
        value: seat.zone_id || '',
        options: [{ value: '', label: 'No zone' }, ...zones.map((z) => ({ value: z.id, label: z.name }))],
      },
      { name: 'row_label', label: 'Row', value: seat.row_label || '' },
      { name: 'col_index', label: 'Column', type: 'number', value: seat.col_index ?? '' },
      {
        name: 'seat_type',
        label: 'Type',
        type: 'select',
        value: seat.seat_type,
        options: ['standard', 'cabin', 'ac', 'premium', 'window'].map((v) => ({ value: v, label: v })),
      },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: seat.status,
        options: ['available', 'maintenance', 'retired'].map((v) => ({ value: v, label: v })),
      },
    ],
    {
      submitLabel: 'Save seat',
      onSubmit: async (values) => {
        await api.updateSeat(seat.id, {
          ...values,
          zone_id: values.zone_id || null,
          col_index: values.col_index === '' ? null : values.col_index,
        });
        closeModal();
        toast('Seat updated');
        await onSaved?.();
      },
    },
  );

  openModal({
    title: `Edit seat ${seat.code}`,
    body: form,
    footer: [
      h(
        'button',
        {
          class: 'btn danger',
          onclick: () => {
            confirmDialog({
              title: `Remove seat ${seat.code}?`,
              message: 'A seat with allocation history is retired rather than deleted.',
              confirmLabel: 'Remove',
              danger: true,
              onConfirm: async () => {
                await api.deleteSeat(seat.id);
                toast(`${seat.code} removed`);
                await onSaved?.();
              },
            });
          },
        },
        'Remove',
      ),
    ],
  });
}

function seatTile(seat, cellsByKey, sessionId, editMode, handlers) {
  const cell = cellsByKey.get(`${seat.id}:${sessionId}`);
  let stateClass = 'vacant';
  if (seat.status !== 'available') stateClass = 'oos';
  else if (cell) stateClass = cell.state;

  const style = Number.isInteger(seat.col_index) ? `grid-column:${seat.col_index}` : '';
  return h(
    'button',
    {
      class: `seat-tile ${stateClass}${editMode && seat.status === 'available' ? ' editing' : ''}`,
      type: 'button',
      style,
      title: cell ? `${cell.member_name} (${cell.member_code}) — until ${cell.end_date}` : seat.code,
      onclick: () => {
        if (editMode) return handlers.onEdit(seat);
        if (seat.status !== 'available') {
          toast('This seat is out of service', 'error');
          return;
        }
        return cell ? handlers.onOccupied(cell, seat) : handlers.onVacant(seat);
      },
    },
    h('span', { class: 'seat-icon-wrap', html: `<svg class="seat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/><path d="M3 11v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"/><path d="M5 18v3"/><path d="M19 18v3"/></svg>` }),
    h('span', { class: 'seat-code' }, seat.code),
  );
}

function renderZone(zone, seats, cellsByKey, sessionId, editMode, handlers) {
  const rows = new Map();
  for (const seat of seats) {
    const key = seat.row_label || '';
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(seat);
  }

  const availableSeats = seats.filter((s) => s.status === 'available');
  const occupiedCount = availableSeats.filter((s) => cellsByKey.has(`${s.id}:${sessionId}`)).length;

  return h(
    'div',
    { class: 'seatmap-zone' },
    h(
      'div',
      { class: 'seatmap-zone-title' },
      zone?.name || 'Unassigned',
      availableSeats.length ? h('span', { class: 'seatmap-zone-count' }, `${occupiedCount}/${availableSeats.length}`) : null,
    ),
    [...rows.entries()].map(([rowLabel, rowSeats]) =>
      h(
        'div',
        { class: 'seatmap-row' },
        rowLabel ? h('div', { class: 'seatmap-row-label' }, rowLabel) : null,
        h('div', { class: 'seatmap-row-grid' }, rowSeats.map((seat) => seatTile(seat, cellsByKey, sessionId, editMode, handlers))),
      ),
    ),
  );
}

export async function renderSeats({ setActions, navigate, params }) {
  // A dashboard deep link (#/seats/<shift-id>) pre-selects that shift's tab;
  // otherwise the map defaults to the first shift, same as a plain #/seats visit.
  const requestedShift = params?.[0] ? Number(params[0]) : null;
  const state = { sessionId: requestedShift, on: today(), editMode: false };
  const container = h('div', {});

  async function load() {
    const map = await api.seatMap({ on: state.on });
    if (!state.sessionId || !map.shifts.some((s) => s.id === state.sessionId)) {
      state.sessionId = map.shifts[0]?.id ?? null;
    }
    render(map);
  }

  function render(map) {
    clear(container);
    setActions();

    if (!map.seats.length) {
      container.append(
        h(
          'div',
          { class: 'empty' },
          h('p', {}, '🪑 No seats yet.'),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: () => openSeatBulkForm({ zones: map.zones, onSaved: load }),
            },
            'Set up your hall',
          ),
        ),
      );
      return;
    }

    const cellsByKey = new Map(map.occupancy.map((o) => [`${o.seat_id}:${o.session_id}`, o]));

    setActions(
      h(
        'button',
        { class: `btn sm ${state.editMode ? 'primary' : 'ghost'}`, onclick: () => { state.editMode = !state.editMode; render(map); } },
        state.editMode ? '✓ Editing layout' : 'Edit layout',
      ),
      h('button', { class: 'btn sm ghost', onclick: () => openSeatBulkForm({ zones: map.zones, onSaved: load }) }, '+ Add seats'),
    );

    const tabs = h(
      'div',
      { class: 'seatmap-tabs' },
      map.shifts.map((shift) => {
        const occupied = map.occupancy.filter((o) => o.session_id === shift.id).length;
        const capacity = shift.capacity ?? map.seats.length;
        const pct = capacity ? Math.min(Math.round((occupied / capacity) * 100), 100) : 0;
        return h(
          'button',
          {
            class: `seatmap-tab ${shift.id === state.sessionId ? 'active' : ''}`,
            type: 'button',
            onclick: () => { state.sessionId = shift.id; render(map); },
          },
          h('div', { class: 'seatmap-tab-name' }, shift.name),
          h('div', { class: 'seatmap-tab-count' }, `${occupied}/${capacity}`),
          h('div', { class: 'seatmap-tab-bar' }, h('i', { style: `width:${pct}%` })),
        );
      }),
      h('input', {
        type: 'date',
        value: state.on,
        class: 'seatmap-date',
        onchange: (e) => { state.on = e.target.value || today(); load(); },
      }),
    );

    const currentShift = map.shifts.find((s) => s.id === state.sessionId);
    const cellsInShift = map.occupancy.filter((o) => o.session_id === state.sessionId);
    const totalSeats = map.seats.filter((s) => s.status === 'available').length;
    const occupiedCount = cellsInShift.length;

    const stats = h(
      'div',
      { class: 'cols-4' },
      stat('Occupancy', totalSeats ? `${Math.round((occupiedCount / totalSeats) * 100)}%` : '0%', `${occupiedCount} of ${totalSeats} seats`),
      stat('Vacant now', Math.max(totalSeats - occupiedCount, 0)),
      stat('Expiring in 7 days', cellsInShift.filter((c) => c.state === 'expiring').length),
      stat('Dues pending', cellsInShift.filter((c) => c.state === 'dues').length),
    );

    const legend = h(
      'div',
      { class: 'seatmap-legend' },
      [
        ['vacant', 'Vacant'],
        ['occupied', 'Occupied'],
        ['expiring', 'Expiring ≤7d'],
        ['expired', 'Expired'],
        ['dues', 'Dues'],
        ['frozen', 'On hold'],
        ['oos', 'Out of service'],
      ].map(([cls, label]) => h('span', { class: 'seatmap-legend-item' }, h('i', { class: `seat-tile ${cls} swatch` }), label)),
    );

    const handlers = {
      onVacant: (seat) =>
        openSeatAssignForm({ seat, sessionId: state.sessionId, shiftName: currentShift?.name || '', onSaved: load }),
      onOccupied: (cell, seat) =>
        openSeatDetailModal({ cell, seat, sessionId: state.sessionId, shiftName: currentShift?.name || '', onSaved: load, navigate }),
      onEdit: (seat) => openSeatEditForm({ seat, zones: map.zones, onSaved: load }),
    };

    const zoneGroups = new Map();
    for (const seat of map.seats) {
      const key = seat.zone_id ?? 'none';
      if (!zoneGroups.has(key)) zoneGroups.set(key, []);
      zoneGroups.get(key).push(seat);
    }
    const hall = h(
      'div',
      { class: 'seatmap-card card' },
      [...zoneGroups.entries()].map(([key, seats]) => {
        const zone = key === 'none' ? null : map.zones.find((z) => z.id === Number(key));
        return renderZone(zone, seats, cellsByKey, state.sessionId, state.editMode, handlers);
      }),
    );

    container.append(tabs, stats, legend, hall);
  }

  container.append(h('div', { class: 'empty' }, 'Loading seat map…'));
  load();
  return container;
}

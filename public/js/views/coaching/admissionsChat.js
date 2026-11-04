import { coaching } from '../../coachingApi.js';
import { buildForm, closeModal, confirmDialog, h, openModal, renderIcon, time, toast } from '../../ui.js';
import { openChatDrawer as sharedChatDrawer, planCard as sharedPlanCard, planLine } from '../whatsappChat.js';
import { fill, WEEKDAYS_LONG } from './common.js';

/**
 * The WhatsApp side of admissions: the transcript drawer behind each lead
 * (shared with GymBook's trials desk, in views/whatsappChat.js), and the
 * assistant's own settings — its name, when it answers,
 * the institute's location, the director's alert number and the demo slots
 * it books into. The assistant itself is src/coaching/receptionist.js.
 */

/** The transcript drawer behind one inquiry — views/whatsappChat.js, bound
 * to the admissions endpoints. */
export function openChatDrawer(lead, { onChange } = {}) {
  sharedChatDrawer({
    title: lead.student_name,
    subtitle: [lead.guardian_name, lead.phone].filter(Boolean).join(' · '),
    org: 'institute',
    load: (params) => coaching.inquiryChat(lead.id, params),
    reply: (text) => coaching.replyInquiryChat(lead.id, text),
    setPaused: (paused) => coaching.pauseInquiryAssistant(lead.id, paused),
    onChange,
  });
}

/* ── Settings ────────────────────────────────────────────────────────── */

const DAY_PRESETS = [
  { value: '1,2,3,4,5,6', label: 'Monday to Saturday' },
  { value: '1,2,3,4,5', label: 'Monday to Friday' },
  { value: '0,1,2,3,4,5,6', label: 'Every day' },
];

const onOff = (name, label, value) => ({
  name,
  label,
  type: 'select',
  value: String(value ?? 0),
  options: [
    { value: '1', label: 'On' },
    { value: '0', label: 'Off' },
  ],
});

function slotRow(slot, { onChanged }) {
  const booked = slot.upcoming ? `${slot.upcoming.booked}/${slot.capacity} booked on ${new Date(`${slot.upcoming.date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : `${slot.capacity} seats`;
  return h(
    'div',
    { class: `cb-demo-slot${slot.active ? '' : ' is-off'}` },
    h('div', { class: 'cb-demo-slot-when' }, h('strong', {}, `${slot.day.slice(0, 3)} ${time(slot.start_time)}`), h('span', { class: 'muted cb-small' }, `${slot.duration_min} min`)),
    h(
      'div',
      { class: 'cb-grow cb-small' },
      h('div', {}, slot.faculty_name ? `${slot.faculty_name}${slot.faculty_qualification ? ` (${slot.faculty_qualification})` : ''}` : 'Teacher not set'),
      h('div', { class: 'muted' }, `${slot.course_name || 'Any course'}${slot.room ? ` · ${slot.room}` : ''} · ${slot.active ? booked : 'Archived'}`),
    ),
    slot.active
      ? h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            title: 'Remove slot',
            'aria-label': `Remove the ${slot.day} ${time(slot.start_time)} demo`,
            onclick: async () => {
              try {
                onChanged(await coaching.deleteDemoSlot(slot.id));
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          renderIcon('trash', { size: 14 }),
        )
      : h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: async () => {
              try {
                onChanged(await coaching.updateDemoSlot(slot.id, { active: true }));
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          'Restore',
        ),
  );
}

function slotEditor(payload, { onChanged }) {
  const select = (name, options, label) => h('select', { name, 'aria-label': label }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  const weekday = select('weekday', WEEKDAYS_LONG.map((label, value) => ({ value, label })), 'Day');
  weekday.value = '3';
  const start = h('input', { type: 'time', value: '16:00', 'aria-label': 'Start time' });
  const capacity = h('input', { type: 'number', min: 1, max: 200, value: 5, 'aria-label': 'Seats', class: 'cb-demo-slot-seats' });
  const faculty = select('faculty_id', [{ value: '', label: 'Teacher…' }, ...payload.faculty.map((f) => ({ value: f.id, label: f.name }))], 'Teacher');
  const course = select('course_id', [{ value: '', label: 'Any course' }, ...payload.courses.map((c) => ({ value: c.id, label: c.name }))], 'Course');
  const add = h(
    'button',
    {
      class: 'btn sm primary',
      type: 'button',
      onclick: async () => {
        add.disabled = true;
        try {
          onChanged(
            await coaching.createDemoSlot({
              weekday: Number(weekday.value),
              start_time: start.value,
              capacity: Number(capacity.value) || 5,
              faculty_id: faculty.value ? Number(faculty.value) : undefined,
              course_id: course.value ? Number(course.value) : undefined,
            }),
          );
          toast('Demo slot added');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          add.disabled = false;
        }
      },
    },
    renderIcon('plus', { size: 14 }),
    'Add',
  );
  return h('div', { class: 'cb-demo-slot-add' }, weekday, start, capacity, h('span', { class: 'muted cb-small' }, 'seats'), faculty, course, add);
}

/* ── The plan ────────────────────────────────────────────────────────── */

export { planLine };

const planCard = (plan, { onPaid }) =>
  sharedPlanCard(plan, { checkout: coaching.assistantCheckout, verify: coaching.assistantVerify, brand: 'CoachBook', onPaid });

/**
 * The assistant's settings and its demo slots, in one modal from the
 * admissions page. The slots save as they are added or removed; the rest
 * saves with the button.
 */
export async function openAssistantSettings({ onSaved } = {}) {
  let payload = await coaching.assistant();
  const s = payload.settings;

  const statusHost = h('div', { class: 'cb-assist-status' });
  const planHost = h('div', {});
  const slotsHost = h('div', { class: 'cb-demo-slots' });
  const renderPlan = () =>
    fill(
      planHost,
      payload.plan
        ? planCard(payload.plan, {
            onPaid: async (fresh) => {
              payload = fresh;
              renderPlan();
              await onSaved?.();
            },
          })
        : null,
    );
  renderPlan();
  const renderStatus = () =>
    fill(
      statusHost,
      h('span', { class: `badge dot ${payload.whatsapp_connected ? 'green' : 'red'}` }, payload.whatsapp_connected ? 'WhatsApp linked' : 'WhatsApp not linked'),
      h('span', { class: `badge dot ${payload.ai_configured ? 'green' : 'amber'}` }, payload.ai_configured ? 'AI ready' : 'AI not set up on this server'),
      !payload.whatsapp_connected ? h('a', { href: '#/whatsapp', class: 'cb-small', onclick: () => closeModal() }, 'Link WhatsApp →') : null,
    );
  const renderSlots = () =>
    fill(
      slotsHost,
      ...(payload.slots.length
        ? payload.slots.map((slot) => slotRow(slot, { onChanged }))
        : [h('p', { class: 'muted cb-small' }, 'No demo slots yet. Add the free demo classes the assistant may book parents into.')]),
      slotEditor(payload, { onChanged }),
    );
  function onChanged(fresh) {
    payload = fresh;
    renderStatus();
    renderSlots();
  }
  renderStatus();
  renderSlots();

  const daysValue = DAY_PRESETS.some((p) => p.value === s.office_days) ? s.office_days : s.office_days || '1,2,3,4,5,6';
  const dayOptions = DAY_PRESETS.some((p) => p.value === daysValue) ? DAY_PRESETS : [...DAY_PRESETS, { value: daysValue, label: `Custom (${daysValue})` }];

  const form = buildForm(
    [
      onOff('ai_receptionist', 'Answer parents on WhatsApp with AI', s.ai_receptionist),
      { name: 'ai_persona_name', label: 'Assistant’s name (optional)', value: s.ai_persona_name || '', placeholder: 'Riya' },
      {
        name: 'ai_reply_mode',
        label: 'When it answers',
        type: 'select',
        value: s.ai_reply_mode,
        options: [
          { value: 'always', label: 'Always — day and night' },
          { value: 'after_hours', label: 'Only outside office hours' },
        ],
      },
      { name: 'office_days', label: 'Office days', type: 'select', value: daysValue, options: dayOptions },
      { name: 'office_open', label: 'Office opens', type: 'time', value: s.office_open },
      { name: 'office_close', label: 'Office closes', type: 'time', value: s.office_close },
      {
        name: 'ai_pause_minutes',
        label: 'Pause after a staff reply (minutes)',
        type: 'number',
        min: 5,
        max: 10080,
        value: s.ai_pause_minutes,
        hint: 'When anyone replies by hand, the assistant stays quiet in that chat this long.',
      },
      {
        name: 'ai_persona_notes',
        label: 'What else it may tell parents',
        type: 'textarea',
        full: true,
        value: s.ai_persona_notes || '',
        placeholder: '42 JEE Main selections in 2026. 10% sibling discount. AC classrooms, weekly tests, doubt sessions every Sunday.',
        hint: 'Results, scholarships, discounts, facilities. The assistant only states facts from your courses, fees, batches and this box.',
      },
      { name: 'institute_phone', label: 'Institute phone', value: s.institute_phone || '', placeholder: '+91 98765 43210' },
      { name: 'institute_address', label: 'Address', value: s.institute_address || '', full: true, placeholder: '2nd floor, Sharma Complex, Civil Lines' },
      { name: 'landmark_directions', label: 'Landmark directions', value: s.landmark_directions || '', full: true, placeholder: 'Opposite SBI ATM, above Bikaner Sweets' },
      {
        name: 'maps_url',
        label: 'Google Maps link',
        value: s.maps_url || '',
        full: true,
        placeholder: 'https://www.google.com/maps/place/…/@26.91,75.78,17z',
        hint: 'Paste the link from your browser’s address bar and the pin is filled in for you.',
      },
      { name: 'latitude', label: 'Latitude', type: 'number', step: 'any', value: s.latitude ?? '' },
      { name: 'longitude', label: 'Longitude', type: 'number', step: 'any', value: s.longitude ?? '' },
      {
        name: 'director_phone',
        label: 'Director’s WhatsApp (hot-lead alerts)',
        value: s.director_phone || '',
        placeholder: '98765 43210',
        hint: 'Gets “🔥 HOT LEAD” the moment a demo is booked. Use a different number from the institute’s.',
      },
      onOff('hot_lead_alerts', 'Hot-lead alerts', s.hot_lead_alerts),
    ],
    {
      submitLabel: 'Save assistant settings',
      onSubmit: async (values) => {
        const body = { ...values };
        for (const key of ['ai_receptionist', 'hot_lead_alerts']) body[key] = values[key] === '1';
        for (const key of ['ai_pause_minutes']) body[key] = Number(values[key]);
        // A changed map link re-derives the pin, unless the numbers were typed too.
        if (values.maps_url && values.maps_url !== (s.maps_url || '') && String(values.latitude) === String(s.latitude ?? '') && String(values.longitude) === String(s.longitude ?? '')) {
          delete body.latitude;
          delete body.longitude;
        }
        const saved = await coaching.updateAssistant(body);
        closeModal();
        toast(
          saved.trial_started
            ? `Your ${saved.plan.trial_days}-day free trial has started — the assistant is answering parents`
            : saved.settings.ai_receptionist
              ? 'Saved — the assistant is answering parents'
              : 'Assistant settings saved',
        );
        await onSaved?.();
      },
    },
  );

  openModal({
    title: 'WhatsApp admissions assistant',
    subtitle: 'Answers parents from your live courses, fees and batches, books free demos, and alerts you about hot leads.',
    icon: 'sparkle',
    wide: true,
    body: h(
      'div',
      { class: 'cb-assist' },
      planHost,
      statusHost,
      h('div', { class: 'cb-assist-slots' }, h('h3', {}, 'Free demo slots'), h('p', { class: 'muted cb-small' }, 'Weekly classes a parent can be booked into. Seats left are counted from the bookings.'), slotsHost),
      form,
    ),
  });
}

/** "Turn it off?" before switching the whole assistant off from the banner. */
export function confirmAssistantOff({ onDone }) {
  confirmDialog({
    title: 'Switch the assistant off?',
    message: 'Parents writing on WhatsApp will wait for your team to reply. Chats so far stay on each lead.',
    confirmLabel: 'Switch off',
    danger: true,
    onConfirm: async () => {
      await coaching.updateAssistant({ ai_receptionist: false });
      toast('The assistant is off');
      await onDone?.();
    },
  });
}

/**
 * CoachBook's parent-facing WhatsApp copy, in one place: the column defaults
 * in schema.js and the "reset to default" in the alert settings both read
 * these, so the two can never drift apart.
 *
 * Every message goes to the guardian's number first (members.emergency_phone,
 * labelled "Guardian" in this vertical) and falls back to the student's own —
 * see guardianPhone() in notify.js. Placeholders are rendered by
 * renderTemplate() in src/whatsapp.js; an unknown one is left visible on
 * purpose, so a typo in an edited template shows up rather than going blank.
 */
export const DEFAULT_TEMPLATES = {
  absence_template:
    'Dear Parent, your ward {{student_name}} was marked ABSENT today ({{date}}) in {{subject_name}} ({{batch_name}}). '
    + 'Please contact {{institute_name}} at {{phone}} if this was not anticipated.',
  late_template:
    'Dear Parent, your ward {{student_name}} arrived LATE today ({{date}}) for {{subject_name}} ({{batch_name}}). - {{institute_name}}',
  fee_due_template:
    'Dear Parent, installment {{installment_no}} of {{amount}} for {{student_name}} at {{institute_name}} is due on {{due_date}}. '
    + 'Please pay to keep enrollment active. Thank you.',
  fee_overdue_template:
    'Dear Parent, installment {{installment_no}} of {{amount}} for {{student_name}} at {{institute_name}} was due on {{due_date}} '
    + 'and is still pending. Please clear it at the earliest.',
  fee_receipt_template:
    'Dear Parent, received {{amount}} towards {{student_name}}\'s fees at {{institute_name}}. '
    + 'Receipt #{{receipt_no}} is attached. Balance: {{balance_amount}}.',
  scorecard_template:
    'Dear Parent, {{student_name}} scored {{marks_obtained}}/{{max_marks}} (Rank: {{rank}} of {{total_students}}) '
    + 'in {{test_title}} at {{institute_name}}. Highest: {{highest}}, Batch Avg: {{average}}.',
  low_attendance_template:
    'Dear Parent, {{student_name}}\'s attendance in {{batch_name}} is {{percentage}}% this month, below the required '
    + '{{threshold}}%. Please ensure regular attendance. - {{institute_name}}',
};

/** The placeholders each template can use, for the settings screen's hint line. */
export const TEMPLATE_PLACEHOLDERS = {
  absence_template: ['student_name', 'date', 'subject_name', 'batch_name', 'institute_name', 'phone'],
  late_template: ['student_name', 'date', 'subject_name', 'batch_name', 'institute_name'],
  fee_due_template: ['student_name', 'installment_no', 'amount', 'due_date', 'course_name', 'institute_name'],
  fee_overdue_template: ['student_name', 'installment_no', 'amount', 'due_date', 'course_name', 'institute_name'],
  fee_receipt_template: ['student_name', 'amount', 'receipt_no', 'balance_amount', 'course_name', 'institute_name'],
  scorecard_template: [
    'student_name', 'marks_obtained', 'max_marks', 'percentage', 'rank', 'total_students', 'highest', 'average', 'test_title', 'subject_name', 'institute_name',
  ],
  low_attendance_template: ['student_name', 'batch_name', 'percentage', 'threshold', 'institute_name'],
};

/** A template as a SQL string literal, for a column DEFAULT. */
export const sqlLiteral = (text) => `'${String(text).replace(/'/g, "''")}'`;

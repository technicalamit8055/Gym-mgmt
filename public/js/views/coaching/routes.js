import { t } from '../../vertical.js';
import { renderCoachingDashboard } from './dashboard.js';
import { renderAttendanceDesk } from './attendance.js';
import { renderAcademics, renderBatchDetail } from './academics.js';
import { renderTimetable } from './timetable.js';
import { renderTests, renderTestDetail } from './tests.js';
import { renderMaterials } from './materials.js';
import { renderFees } from './fees.js';
import { renderAdmissions } from './admissions.js';
import { renderFaculty } from './faculty.js';

/**
 * CoachBook's sidebar, phone tabs and routes — the third vertical's share of
 * app.js's buildNav()/buildRoutes()/buildTabs(), kept with its own views.
 * Built per call (never at module load) for the reason app.js gives: t()
 * only answers for this vertical once boot() has called setVertical().
 */

export function coachingNav() {
  return [
    { section: 'Daily' },
    { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { path: '/attendance', label: 'Attendance desk', icon: 'checkin' },
    { path: '/check-in', label: 'Gate check-in', icon: 'scan' },
    { path: '/members', label: t('members'), icon: 'members' },
    { section: 'Academic' },
    { path: '/courses', label: 'Courses & batches', icon: 'graduation' },
    { path: '/timetable', label: 'Timetable', icon: 'calendar' },
    { path: '/tests', label: 'Tests & marks', icon: 'trophy' },
    { path: '/materials', label: 'Study material', icon: 'fileText' },
    { section: 'Business' },
    // Money, so the API limits the whole fees screen to the billing roles —
    // hidden rather than letting a teacher click into a 403.
    { path: '/fees', label: 'Fees & installments', icon: 'wallet', roles: ['admin', 'manager'] },
    { path: '/admissions', label: 'Admissions', icon: 'userPlus' },
    { path: '/reports', label: 'Reports', icon: 'reports' },
    { path: '/whatsapp', label: 'WhatsApp', icon: 'whatsapp', roles: ['admin', 'manager'] },
    { path: '/notifications', label: 'Push notifications', icon: 'bell', roles: ['admin', 'manager'] },
    { section: 'Operations' },
    { path: '/faculty', label: 'Faculty', icon: 'users' },
    { path: '/devices', label: 'Biometric devices', icon: 'devices' },
    { path: '/staff', label: 'Staff accounts', icon: 'staff' },
    { path: '/settings', label: t('settings'), icon: 'settings' },
  ];
}

/** The four everyday screens on the phone tab bar. */
export function coachingTabs() {
  return [
    { path: '/dashboard', label: 'Home', icon: 'home' },
    { path: '/attendance', label: 'Attendance', icon: 'checkin' },
    { path: '/members', label: t('members'), icon: 'members' },
    { path: '/tests', label: 'Tests', icon: 'trophy' },
  ];
}

export function coachingRoutes() {
  return [
    { pattern: /^\/dashboard$/, title: 'Dashboard', view: renderCoachingDashboard },
    {
      pattern: /^\/attendance$/,
      title: 'Attendance desk',
      icon: 'checkin',
      iconTone: 'blue',
      subtitle: 'One tap per student — absent students’ parents are alerted on WhatsApp',
      view: renderAttendanceDesk,
    },
    {
      pattern: /^\/courses$/,
      title: 'Courses & batches',
      icon: 'graduation',
      iconTone: 'violet',
      subtitle: 'Programs, subjects, batches, fee structures and classrooms',
      view: renderAcademics,
    },
    { pattern: /^\/batches\/(\d+)$/, title: 'Batch', view: renderBatchDetail },
    {
      pattern: /^\/timetable$/,
      title: 'Timetable',
      icon: 'calendar',
      iconTone: 'orange',
      subtitle: 'Weekly lectures by batch, teacher and room — clashes are caught as you plan',
      view: renderTimetable,
    },
    {
      pattern: /^\/tests$/,
      title: 'Tests & marks',
      icon: 'trophy',
      iconTone: 'amber',
      subtitle: 'Weekly tests, mocks and DPPs — marks, ranks and parent scorecards',
      view: renderTests,
    },
    { pattern: /^\/tests\/(\d+)$/, title: 'Test', view: renderTestDetail },
    {
      pattern: /^\/materials$/,
      title: 'Study material',
      icon: 'fileText',
      iconTone: 'blue',
      subtitle: 'Notes, DPPs, PYQs and assignments for each batch',
      view: renderMaterials,
    },
    {
      pattern: /^\/fees$/,
      title: 'Fees & installments',
      icon: 'wallet',
      iconTone: 'green',
      subtitle: 'Course fees, installment schedules, collections and receipts',
      view: renderFees,
    },
    {
      pattern: /^\/admissions$/,
      title: 'Admissions',
      icon: 'userPlus',
      iconTone: 'violet',
      subtitle: 'Inquiries, demo classes and follow-ups, through to admission',
      view: renderAdmissions,
    },
    {
      pattern: /^\/faculty$/,
      title: 'Faculty',
      icon: 'users',
      iconTone: 'blue',
      subtitle: 'Teachers, what they teach, weekly load and this month’s lectures',
      view: renderFaculty,
    },
  ];
}

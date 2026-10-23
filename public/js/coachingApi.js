/**
 * CoachBook's endpoints (src/routes/coaching/), kept beside api.js rather
 * than inside it so the third vertical's surface stays in one file. Every
 * call goes through api.js's own request(), so auth, the 401 sign-out and
 * error details behave exactly like the rest of the app.
 */
import { ApiError, apiQuery as query, apiRequest as request, memberSession, pathPrefix, saveFile, serverUrl, session } from './api.js';

const C = '/coaching';

/** Fetches an authenticated file and hands it to the browser as a download. */
async function download(path, fileName, { member = false } = {}) {
  const token = member ? memberSession.token : session.token;
  const res = await fetch(serverUrl(`${pathPrefix}/api${path}`), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = 'Could not download that file';
    try {
      message = (await res.json()).error || message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message);
  }
  const disposition = res.headers.get('content-disposition') || '';
  const named = /filename="([^"]+)"/.exec(disposition)?.[1];
  return saveFile(await res.blob(), fileName || (named ? decodeURIComponent(named) : 'download'));
}

/** A raw-body upload with its metadata in the query string. */
async function upload(path, file, params) {
  const res = await fetch(serverUrl(`${pathPrefix}/api${path}${query(params)}`), {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', Authorization: `Bearer ${session.token}` },
    body: file,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, payload.error || res.statusText, payload.details);
  return payload;
}

export const coaching = {
  dashboard: () => request('GET', `${C}/dashboard`),
  settings: () => request('GET', `${C}/settings`),
  updateSettings: (payload) => request('PATCH', `${C}/settings`, payload),

  // Courses, subjects, batches, fee structures, classrooms, faculty
  courses: (params) => request('GET', `${C}/courses${query(params)}`),
  course: (id) => request('GET', `${C}/courses/${id}`),
  createCourse: (payload) => request('POST', `${C}/courses`, payload),
  updateCourse: (id, payload) => request('PATCH', `${C}/courses/${id}`, payload),
  deleteCourse: (id) => request('DELETE', `${C}/courses/${id}`),
  createSubject: (courseId, payload) => request('POST', `${C}/courses/${courseId}/subjects`, payload),
  updateSubject: (id, payload) => request('PATCH', `${C}/subjects/${id}`, payload),
  deleteSubject: (id) => request('DELETE', `${C}/subjects/${id}`),
  createFeeStructure: (courseId, payload) => request('POST', `${C}/courses/${courseId}/fee-structures`, payload),
  updateFeeStructure: (id, payload) => request('PATCH', `${C}/fee-structures/${id}`, payload),
  deleteFeeStructure: (id) => request('DELETE', `${C}/fee-structures/${id}`),
  batches: (params) => request('GET', `${C}/batches${query(params)}`),
  batch: (id) => request('GET', `${C}/batches/${id}`),
  createBatch: (payload) => request('POST', `${C}/batches`, payload),
  updateBatch: (id, payload) => request('PATCH', `${C}/batches/${id}`, payload),
  deleteBatch: (id) => request('DELETE', `${C}/batches/${id}`),
  allocateFaculty: (batchId, payload) => request('POST', `${C}/batches/${batchId}/faculty`, payload),
  removeAllocation: (id) => request('DELETE', `${C}/faculty-allocations/${id}`),
  classrooms: () => request('GET', `${C}/classrooms`),
  createClassroom: (payload) => request('POST', `${C}/classrooms`, payload),
  updateClassroom: (id, payload) => request('PATCH', `${C}/classrooms/${id}`, payload),
  deleteClassroom: (id) => request('DELETE', `${C}/classrooms/${id}`),
  faculty: () => request('GET', `${C}/faculty`),
  updateFaculty: (id, payload) => request('PATCH', `${C}/faculty/${id}`, payload),

  // Students & enrollment
  academics: (memberId) => request('GET', `${C}/students/${memberId}/academics`),
  enroll: (payload) => request('POST', `${C}/enrollments`, payload),
  updateEnrollment: (id, payload) => request('PATCH', `${C}/enrollments/${id}`, payload),
  transferEnrollment: (id, payload) => request('POST', `${C}/enrollments/${id}/transfer`, payload),
  removeEnrollment: (id) => request('DELETE', `${C}/enrollments/${id}`),

  // Admissions
  inquiries: (params) => request('GET', `${C}/inquiries${query(params)}`),
  createInquiry: (payload) => request('POST', `${C}/inquiries`, payload),
  updateInquiry: (id, payload) => request('PATCH', `${C}/inquiries/${id}`, payload),
  deleteInquiry: (id) => request('DELETE', `${C}/inquiries/${id}`),
  admitInquiry: (id, payload) => request('POST', `${C}/inquiries/${id}/admit`, payload),
  // The WhatsApp chat behind a lead, and the admissions assistant answering it
  inquiryChat: (id, params) => request('GET', `${C}/inquiries/${id}/whatsapp${query(params)}`),
  replyInquiryChat: (id, text) => request('POST', `${C}/inquiries/${id}/whatsapp/reply`, { text }),
  pauseInquiryAssistant: (id, paused) => request('POST', `${C}/inquiries/${id}/whatsapp/assistant`, { paused }),
  assistant: () => request('GET', `${C}/admissions/assistant`),
  updateAssistant: (payload) => request('PATCH', `${C}/admissions/assistant`, payload),
  assistantCheckout: (months) => request('POST', `${C}/admissions/assistant/checkout`, { months }),
  assistantVerify: (payment) => request('POST', `${C}/admissions/assistant/verify`, payment),
  createDemoSlot: (payload) => request('POST', `${C}/admissions/demo-slots`, payload),
  updateDemoSlot: (id, payload) => request('PATCH', `${C}/admissions/demo-slots/${id}`, payload),
  deleteDemoSlot: (id) => request('DELETE', `${C}/admissions/demo-slots/${id}`),

  // Fees
  feeSummary: () => request('GET', `${C}/fees/summary`),
  feePlans: (params) => request('GET', `${C}/fees/plans${query(params)}`),
  feePlan: (id) => request('GET', `${C}/fees/plans/${id}`),
  createFeePlan: (payload) => request('POST', `${C}/fees/plans`, payload),
  updateFeePlan: (id, payload) => request('PATCH', `${C}/fees/plans/${id}`, payload),
  reschedule: (id, installments) => request('PUT', `${C}/fees/plans/${id}/schedule`, { installments }),
  collect: (planId, payload) => request('POST', `${C}/fees/plans/${planId}/payments`, payload),
  dues: (params) => request('GET', `${C}/fees/dues${query(params)}`),
  remindInstallment: (id) => request('POST', `${C}/fees/installments/${id}/remind`, {}),
  remindOverdue: () => request('POST', `${C}/fees/remind-overdue`, {}),
  feePayments: (params) => request('GET', `${C}/fees/payments${query(params)}`),
  sendReceipt: (id) => request('POST', `${C}/fees/payments/${id}/send-receipt`, {}),
  chequeAction: (id, action) => request('POST', `${C}/fees/payments/${id}/cheque`, { action }),
  deletePayment: (id) => request('DELETE', `${C}/fees/payments/${id}`),
  downloadReceipt: (id) => download(`${C}/fees/payments/${id}/receipt`, `Fee_Receipt_FEE-${String(id).padStart(5, '0')}.pdf`),

  // Attendance
  attendanceDay: (params) => request('GET', `${C}/attendance/day${query(params)}`),
  attendanceSheet: (params) => request('GET', `${C}/attendance/sheet${query(params)}`),
  saveAttendance: (payload) => request('PUT', `${C}/attendance/sheet`, payload),
  resendAbsenceAlerts: (payload) => request('POST', `${C}/attendance/sheet/alerts`, payload),
  attendanceReport: (params) => request('GET', `${C}/attendance/report${query(params)}`),
  lowAttendanceAlerts: (payload) => request('POST', `${C}/attendance/low-alerts`, payload),
  attendanceCalendar: (memberId, params) => request('GET', `${C}/attendance/students/${memberId}/calendar${query(params)}`),

  // Timetable & lecture log
  timetable: (params) => request('GET', `${C}/timetable${query(params)}`),
  checkSlot: (payload) => request('POST', `${C}/timetable/check`, payload),
  createSlot: (payload) => request('POST', `${C}/timetable`, payload),
  updateSlot: (id, payload) => request('PATCH', `${C}/timetable/${id}`, payload),
  deleteSlot: (id) => request('DELETE', `${C}/timetable/${id}`),
  lectureLogs: (params) => request('GET', `${C}/lecture-logs${query(params)}`),
  logLecture: (payload) => request('POST', `${C}/lecture-logs`, payload),
  deleteLectureLog: (id) => request('DELETE', `${C}/lecture-logs/${id}`),

  // Tests
  tests: (params) => request('GET', `${C}/tests${query(params)}`),
  test: (id) => request('GET', `${C}/tests/${id}`),
  createTest: (payload) => request('POST', `${C}/tests`, payload),
  updateTest: (id, payload) => request('PATCH', `${C}/tests/${id}`, payload),
  deleteTest: (id) => request('DELETE', `${C}/tests/${id}`),
  saveMarks: (id, entries) => request('PUT', `${C}/tests/${id}/marks`, { entries }),
  publishTest: (id, notify) => request('POST', `${C}/tests/${id}/publish`, { notify }),
  unpublishTest: (id) => request('POST', `${C}/tests/${id}/unpublish`, {}),
  reportCard: (memberId, params) => request('GET', `${C}/tests/students/${memberId}/report-card${query(params)}`),

  // Study material
  materials: (params) => request('GET', `${C}/materials${query(params)}`),
  addMaterialLink: (payload) => request('POST', `${C}/materials`, payload),
  uploadMaterial: (file, params) => upload(`${C}/materials/upload`, file, { ...params, file_name: file.name }),
  updateMaterial: (id, payload) => request('PATCH', `${C}/materials/${id}`, payload),
  deleteMaterial: (id) => request('DELETE', `${C}/materials/${id}`),
  downloadMaterial: (id) => download(`${C}/materials/${id}/file`),
  submissions: (id) => request('GET', `${C}/materials/${id}/submissions`),
  setSubmission: (id, payload) => request('PUT', `${C}/materials/${id}/submissions`, payload),

  // The student & parent app
  portal: {
    overview: () => request('GET', '/portal/coaching/overview', undefined, { member: true }),
    timetable: () => request('GET', '/portal/coaching/timetable', undefined, { member: true }),
    attendance: (month) => request('GET', `/portal/coaching/attendance${query({ month })}`, undefined, { member: true }),
    tests: () => request('GET', '/portal/coaching/tests', undefined, { member: true }),
    materials: () => request('GET', '/portal/coaching/materials', undefined, { member: true }),
    downloadMaterial: (id) => download(`/portal/coaching/materials/${id}/file`, undefined, { member: true }),
    fees: () => request('GET', '/portal/coaching/fees', undefined, { member: true }),
    downloadReceipt: (id) =>
      download(`/portal/coaching/fees/payments/${id}/receipt`, `Fee_Receipt_FEE-${String(id).padStart(5, '0')}.pdf`, { member: true }),
  },
};

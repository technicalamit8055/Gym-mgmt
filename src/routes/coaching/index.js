import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { academicRoutes } from './academics.js';
import { admissionRoutes } from './admissions.js';
import { attendanceRoutes } from './attendance.js';
import { feeRoutes } from './fees.js';
import { materialRoutes } from './materials.js';
import { overviewRoutes } from './overview.js';
import { studentRoutes } from './students.js';
import { testRoutes } from './tests.js';
import { timetableRoutes } from './timetable.js';

/**
 * CoachBook's staff API, mounted at /api/coaching.
 *
 * requireAuth runs first and each sub-router then gates on its own module
 * (verticals.js's requireModule), so a gym or library account gets the same
 * 404 `module_not_enabled` for all of it that it gets for any module it does
 * not have — and an anonymous caller cannot probe which ones exist.
 */
export const coachingRoutes = Router();
coachingRoutes.use(requireAuth);
coachingRoutes.use(overviewRoutes);
coachingRoutes.use(academicRoutes);
coachingRoutes.use(studentRoutes);
coachingRoutes.use(admissionRoutes);
coachingRoutes.use(feeRoutes);
coachingRoutes.use(attendanceRoutes);
coachingRoutes.use(timetableRoutes);
coachingRoutes.use(testRoutes);
coachingRoutes.use(materialRoutes);

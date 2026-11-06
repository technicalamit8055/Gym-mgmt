import { Router } from 'express';
import { requireAuth } from '../../auth.js';
import { academicRoutes } from './academics.js';
import { admissionRoutes } from './admissions.js';
import { attendanceRoutes } from './attendance.js';
import { feeRoutes } from './fees.js';
import { liveRoutes } from './live.js';
import { materialRoutes } from './materials.js';
import { omrRoutes } from './omr.js';
import { overviewRoutes } from './overview.js';
import { paperRoutes } from './papers.js';
import { recordingRoutes } from './recordings.js';
import { studentRoutes } from './students.js';
import { studioDeviceRoutes } from './studio.js';
import { testRoutes } from './tests.js';
import { timetableRoutes } from './timetable.js';
import { streamingRoutes } from './streaming.js';
import { youtubeRoutes } from './youtube.js';

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
// Ahead of testRoutes, whose /tests/:id would otherwise take /tests/generator.
coachingRoutes.use(paperRoutes);
coachingRoutes.use(testRoutes);
coachingRoutes.use(omrRoutes);
coachingRoutes.use(materialRoutes);
coachingRoutes.use(liveRoutes);
coachingRoutes.use(recordingRoutes);
coachingRoutes.use(studioDeviceRoutes);
coachingRoutes.use(youtubeRoutes);
coachingRoutes.use(streamingRoutes);

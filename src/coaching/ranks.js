/**
 * Ranks, percentiles and batch statistics for one test.
 *
 * Pure: takes the marks rows, returns new ones — so the rule is testable on
 * its own and the route only has to write the result back.
 *
 * - Rank is competition ranking ("1224"): two students on 88 are both 2nd and
 *   the next is 4th, the way a rank list on a notice board reads.
 * - Percentile is the NTA definition JEE/NEET families already know:
 *   100 × (students scoring at or below you) ÷ (students who sat the test).
 * - Absent students get neither, and are left out of the highest, average
 *   and the "out of N" — they did not sit the paper.
 */
export function rankMarks(rows) {
  const present = rows.filter((r) => !r.is_absent);
  const sorted = [...present].sort((a, b) => b.marks_obtained - a.marks_obtained);
  const n = sorted.length;

  const rankOf = new Map();
  sorted.forEach((row, i) => {
    const prev = sorted[i - 1];
    rankOf.set(row, prev && prev.marks_obtained === row.marks_obtained ? rankOf.get(prev) : i + 1);
  });

  return rows.map((row) => {
    if (row.is_absent) return { ...row, rank: null, percentile: null };
    const atOrBelow = sorted.filter((other) => other.marks_obtained <= row.marks_obtained).length;
    return {
      ...row,
      rank: rankOf.get(row),
      percentile: n ? Math.round((atOrBelow / n) * 10000) / 100 : null,
    };
  });
}

export function testStats(rows, { maxMarks, passingMarks = 0 } = {}) {
  const present = rows.filter((r) => !r.is_absent);
  const marks = present.map((r) => r.marks_obtained);
  const round = (v) => Math.round(v * 100) / 100;
  const average = marks.length ? round(marks.reduce((a, b) => a + b, 0) / marks.length) : null;
  return {
    appeared: present.length,
    absent: rows.length - present.length,
    highest: marks.length ? Math.max(...marks) : null,
    lowest: marks.length ? Math.min(...marks) : null,
    average,
    average_percentage: average !== null && maxMarks ? round((average / maxMarks) * 100) : null,
    passed: passingMarks > 0 ? present.filter((r) => r.marks_obtained >= passingMarks).length : null,
  };
}

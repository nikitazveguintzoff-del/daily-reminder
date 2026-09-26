import { EDCore } from "@papillonapp/ed-core";

export type CourseItem = {
  subject: string;
  start: string;
  room: string;
  teacher: string;
};

export type HomeworkItem = {
  subject: string;
  content: string;
  dueDate: string;
};

export type GradeItem = {
  subject: string;
  value: string;
  date: string;
};

export type SchoolData = {
  courses: CourseItem[];
  homeworks: HomeworkItem[];
  latestGrade: GradeItem | null;
  syncedAt: string;
};

export type EdSession = InstanceType<typeof EDCore>;

export function createEdSession(): EdSession {
  return new EDCore();
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchSchoolData(
  session: EdSession,
  homeworkDays: number
): Promise<SchoolData> {
  const today = new Date();
  const todayKey = dayKey(today);
  const [courses, homeworkDaysData, gradeData] = await Promise.all([
    session.timetable.fetchByDay(todayKey),
    Promise.all(
      Array.from({ length: homeworkDays }, (_, offset) => {
        const date = new Date(today);
        date.setDate(today.getDate() + offset);
        const key = dayKey(date);
        return session.homeworks.getByDay(key, false).then((result) => ({ key, result }));
      })
    ),
    session.grades.fetch()
  ]);

  const mappedCourses = courses.map((course) => ({
    subject: course.matiere || course.text || "Cours",
    start: course.start_date || "",
    room: course.salle || "",
    teacher: course.prof || ""
  }));

  const homeworks = homeworkDaysData.flatMap(({ key, result }) =>
    result.matieres.flatMap((item) => {
      const content = item.aFaire?.contenu ? plainText(item.aFaire.contenu) : "";
      return content
        ? [{ subject: item.matiere || "Devoir", content, dueDate: key }]
        : [];
    })
  );

  const latest = [...gradeData.notes].sort((first, second) =>
    (second.dateSaisie || second.date).localeCompare(first.dateSaisie || first.date)
  )[0];

  return {
    courses: mappedCourses,
    homeworks,
    latestGrade: latest
      ? {
          subject: latest.libelleMatiere || "Note",
          value: `${latest.valeur}${latest.noteSur ? ` / ${latest.noteSur}` : ""}`,
          date: latest.dateSaisie || latest.date || ""
        }
      : null,
    syncedAt: new Date().toISOString()
  };
}
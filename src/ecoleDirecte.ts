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

type StudentAccount = {
  id: number;
  typeCompte: string;
  prenom?: string;
  nom?: string;
};

export type EdSession = {
  gtk?: string;
  token?: string;
  student?: StudentAccount;
};

export type LoginChallenge = {
  question: string;
  options: { label: string; value: string }[];
};

type ApiResponse<T> = {
  code: number;
  token?: string;
  message?: string | null;
  data: T;
};

const API_BASE = "https://api.ecoledirecte.com";
const API_VERSION = "4.75.0";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36";

export class EdApiError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "EdApiError";
  }
}

export function createEdSession(): EdSession {
  return {};
}

function apiError(response: ApiResponse<unknown>): EdApiError {
  const messages: Record<number, string> = {
    250: "Une vérification de sécurité est nécessaire.",
    505: "Identifiant ou mot de passe incorrect.",
    517: "La version de l'API École Directe n'est plus acceptée.",
    520: "La session École Directe est invalide.",
    525: "La session École Directe a expiré. Reconnecte-toi."
  };
  return new EdApiError(
    messages[response.code] || response.message || `Erreur École Directe (${response.code}).`,
    response.code
  );
}

async function readResponse<T>(response: Response): Promise<ApiResponse<T>> {
  let result: ApiResponse<T>;
  try {
    result = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new Error("Réponse École Directe illisible.");
  }
  if (!response.ok) {
    throw new Error(`École Directe ne répond pas (${response.status}).`);
  }
  return result;
}

async function request<T>(
  session: EdSession,
  path: string,
  verb: "get" | "post",
  body: unknown
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}?verbe=${verb}&v=${API_VERSION}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      ...(session.token ? { "X-Token": session.token } : {})
    },
    body: `data=${encodeURIComponent(JSON.stringify(body))}`
  });
  const result = await readResponse<T>(response);
  if (result.code !== 200) throw apiError(result);
  return result.data;
}

async function getGtk(): Promise<string> {
  const response = await fetch(`${API_BASE}/v3/login.awp?gtk=1&v=${API_VERSION}`, {
    headers: { "User-Agent": USER_AGENT }
  });
  if (!response.ok) throw new Error(`Impossible de démarrer la connexion (${response.status}).`);
  const cookies = response.headers.get("set-cookie") || response.headers.get("set-cookie2") || "";
  const gtk = cookies.match(/(?:^|[,;\s])GTK=([^;,\s]+)/i)?.[1];
  if (!gtk) throw new Error("École Directe n'a pas transmis le cookie de connexion GTK.");
  return gtk;
}

export async function login(
  session: EdSession,
  username: string,
  password: string,
  uuid: string,
  factors?: { cn: string; cv: string }[]
): Promise<void> {
  session.gtk ||= await getGtk();
  const response = await fetch(`${API_BASE}/v3/login.awp?v=${API_VERSION}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      "X-Gtk": session.gtk
    },
    body: `data=${encodeURIComponent(
      JSON.stringify({
        identifiant: username,
        motdepasse: password,
        isRelogin: false,
        uuid,
        ...(factors ? { fa: factors } : {})
      })
    )}`
  });
  const result = await readResponse<{ accounts: StudentAccount[] }>(response);
  session.token = result.token || undefined;
  if (result.code !== 200) throw apiError(result);
  const accounts = result.data?.accounts || [];
  const student = accounts.find((account) => account.typeCompte === "E") || accounts[0];
  if (!student) throw new Error("Aucun compte élève n'est associé à ces identifiants.");
  session.student = student;
}

function decodeBase64(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;
  for (const character of normalized) {
    if (character === "=") break;
    const digit = alphabet.indexOf(character);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >> bitCount) & 0xff);
    }
  }
  const encoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(encoded);
  } catch {
    return bytes.map((byte) => String.fromCharCode(byte)).join("");
  }
}

export async function fetchLoginChallenge(session: EdSession): Promise<LoginChallenge> {
  const challenge = await request<{ question: string; propositions: string[] }>(
    session,
    "/v3/connexion/doubleauth.awp",
    "get",
    {}
  );
  return {
    question: decodeBase64(challenge.question),
    options: challenge.propositions.map((value) => ({ label: decodeBase64(value), value }))
  };
}

export async function resolveLoginChallenge(
  session: EdSession,
  selectedOption: string
): Promise<{ cn: string; cv: string }> {
  return request(session, "/v3/connexion/doubleauth.awp", "post", { choix: selectedOption });
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

function parseEdDate(dateStr: string): number {
  if (!dateStr) return 0;
  if (dateStr.includes("/")) {
    const [day, month, year] = dateStr.split("/");
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`).getTime() || 0;
  }
  return new Date(dateStr).getTime() || 0;
}

export async function fetchSchoolData(
  session: EdSession,
  homeworkDays: number
): Promise<SchoolData> {
  if (!session.student || !session.token) throw new Error("Aucun compte École Directe connecté.");
  const studentId = session.student.id;
  const today = new Date();
  const todayKey = dayKey(today);
  const [courses, homeworkDaysData, gradeData] = await Promise.all([
    request<Array<{ matiere?: string; text?: string; start_date?: string; salle?: string; prof?: string }>>(
      session,
      `/v3/E/${studentId}/emploidutemps.awp`,
      "get",
      { dateDebut: todayKey, dateFin: todayKey, avecTrous: false }
    ),
    Promise.all(
      Array.from({ length: homeworkDays }, (_, offset) => {
        const date = new Date(today);
        date.setDate(today.getDate() + offset);
        const key = dayKey(date);
        return request<{ matieres?: { matiere?: string; aFaire?: { contenu?: string } }[] }>(
          session,
          `/v3/Eleves/${studentId}/cahierdetexte/${key}.awp`,
          "get",
          {}
        )
          .then((result) => ({ key, result }))
          .catch(() => ({ key, result: { matieres: [] } }));
      })
    ),
    request<{
      notes?: {
        libelleMatiere?: string;
        valeur?: string;
        noteSur?: string;
        dateSaisie?: string;
        date?: string;
      }[];
    }>(session, `/v3/eleves/${studentId}/notes.awp`, "get", {
      anneeScolaire: ""
    })
  ]);

  const mappedCourses = courses.map((course) => ({
    subject: course.matiere || course.text || "Cours",
    start: course.start_date || "",
    room: course.salle || "",
    teacher: course.prof || ""
  }));

  const homeworks = homeworkDaysData.flatMap(({ key, result }) =>
    (result.matieres || []).flatMap((item) => {
      const content = item.aFaire?.contenu ? plainText(decodeBase64(item.aFaire.contenu)) : "";
      return content
        ? [{ subject: item.matiere || "Devoir", content, dueDate: key }]
        : [];
    })
  );

  const latest = [...(gradeData.notes || [])].sort((first, second) => {
    const timeFirst = parseEdDate(first.dateSaisie || first.date || "");
    const timeSecond = parseEdDate(second.dateSaisie || second.date || "");
    return timeSecond - timeFirst;
  })[0];

  return {
    courses: mappedCourses,
    homeworks,
    latestGrade: latest
      ? {
          subject: latest.libelleMatiere || "Note",
          value: `${latest.valeur || ""}${latest.noteSur ? ` / ${latest.noteSur}` : ""}`,
          date: latest.dateSaisie || latest.date || ""
        }
      : null,
    syncedAt: new Date().toISOString()
  };
}
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import {
  ArrowRight,
  Bell,
  BookOpen,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Check,
  ClipboardList,
  GraduationCap,
  House,
  LogOut,
  Mail,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
  UserRound,
  X
} from "lucide-react-native";
import { WebView } from "react-native-webview";
import { PronoteSsoModal } from "./src/PronoteSsoModal";
import { PhotoWebViewHost } from "./src/PhotoWebViewHost";
import { CHILDREN_PROFILES_KEY, PROVIDER_ACCOUNTS_KEY, persistProviderAccounts, providerTokenKey, readProviderAccounts } from "./src/accountStorage";
import { findFirstCourseDay, syncChildMessages, syncChildren, type ChildMessages } from "./src/sync";
import { DevTools } from "./src/DevTools";
import { forgetPhoto, getCachedPhoto, photoCacheKey } from "./src/photos";
import "./src/photoStore";
import { pronoteBaseUrl, type PronoteSsoCapture } from "./src/providers/pronoteSso";
import {
  getCurrentOrNextHoliday,
  getSavedZone,
  saveZone,
  SCHOOL_HOLIDAYS,
  type SchoolZone
} from "./src/holidays";
import {
  BACKGROUND_SYNC_ENABLED_KEY,
  CREDENTIALS_KEY,
  DEVICE_KEY,
  PREFS_KEY,
  disableBackgroundSync,
  enableBackgroundSync,
  getBackgroundSyncStatus,
  readBackgroundSyncData,
  type BackgroundSyncStatus
} from "./src/backgroundSync";
import {
  createEdSession,
  fetchLoginChallenge,
  fetchStudentsSchoolDataWithAutoAdvance,
  login,
  relogin,
  resolveLoginChallenge,
  type EdSession,
  type EdPupil,
  type HomeworkItem,
  type LoginChallenge as EdLoginChallenge,
  type SchoolData
} from "./src/ecoleDirecte";
import {
  defaultPreferences,
  normalizeTime,
  scheduleDailyReminders,
  sendTestNotifications,
  type ReminderPreferences
} from "./src/reminders";
import {
  connectPronoteSso,
  finishSkolengoLogin,
  restorePronote,
  restoreSkolengoLogin,
  searchSkolengoSchools,
  startSkolengoLogin,
  type SkolengoLoginStart
} from "./src/providers/schoolServices";
import type {
  ChildProfile,
  DomainType,
  ProviderAccount,
  ProviderSession,
  ProviderStudent,
  ProviderType
} from "./src/providers/types";
import { withDefaultSources } from "./src/providers/types";

const ACTIVE_CHILD_KEY = "tempo-active-child-id-v2";

if (Platform.OS !== "web") Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
});


type Tab = "journal" | "messages" | "rappels" | "compte";
type LoginChallenge = {
  session: EdSession;
  username: string;
  password: string;
  uuid: string;
} & EdLoginChallenge;

const tabItems: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: "journal", label: "Journal", Icon: House },
  { id: "messages", label: "Messages", Icon: Mail },
  { id: "rappels", label: "Rappels", Icon: Bell },
  { id: "compte", label: "Compte", Icon: UserRound }
];

function frenchDate(date = new Date()): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(date);
}

function isToday(date: Date): boolean {
  const today = new Date();
  return date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
}

function courseTime(value: string): string {
  return value.match(/\d{2}:\d{2}/)?.[0] ?? "--:--";
}

function shortDate(value: string): string {
  const timestamp = dateTimestamp(value);
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(date);
}

function dateTimestamp(value: string): number {
  const datePart = value.slice(0, 10);
  if (datePart.includes("/")) {
    const [day, month, year] = datePart.split("/");
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T12:00:00`).getTime();
  }
  return new Date(`${datePart}T12:00:00`).getTime();
}

function normalizePhotoUri(photo?: string): string | undefined {
  const value = photo?.trim();
  if (!value) return undefined;
  if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://www.ecoledirecte.com${value}`;
  if (/^[A-Za-z0-9+/=_-]+$/.test(value)) return `data:image/jpeg;base64,${value}`;
  return undefined;
}

function photoUriDiagnostic(photo?: string): {
  present: boolean;
  length: number;
  kind: string;
  protocol?: string;
  host?: string;
} {
  const uri = photo?.trim() || "";
  let protocol: string | undefined;
  let host: string | undefined;
  try {
    const parsed = new URL(uri);
    protocol = parsed.protocol;
    host = parsed.host;
  } catch {
    // Not all photo values are URLs; the kind below identifies other formats.
  }
  return {
    present: !!uri,
    length: uri.length,
    ...(protocol ? { protocol, host } : {}),
    kind: /^data:image\//i.test(uri)
      ? "data-uri"
      : /^https?:\/\//i.test(uri)
        ? "absolute-url"
        : uri.startsWith("//")
          ? "protocol-relative-url"
          : uri.startsWith("/")
            ? "relative-path"
            : /^[A-Za-z0-9+/=_-]+$/.test(uri)
              ? "base64-like"
              : uri ? "other" : "missing"
  };
}

function sanitizePhotoError(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      return `${new URL(value).origin}/[redacted]`;
    } catch {
      return "[redacted URL]";
    }
  });
}

function childProfilePhoto(child: ChildProfile, accounts: ProviderAccount[]): string | undefined {
  const providers = [...new Set([
    child.sources.photo,
    ...Object.keys(child.links) as ProviderType[]
  ].filter((provider): provider is ProviderType => provider !== null))];
  for (const provider of providers) {
    const link = child.links[provider];
    if (!link) continue;
    const photo = accounts
      .find((account) => account.id === link.accountId)
      ?.students.find((student) => student.id === link.studentId)?.photo;
    const photoUri = normalizePhotoUri(photo);
    if (photoUri) return getCachedPhoto(photoUri) ?? photoUri;
  }
  return undefined;
}

function logLoginFailure(message: string, error: unknown, ...details: unknown[]): void {
  const errorCode = (error as { code?: number })?.code;
  const log = errorCode === 250 ? console.log : console.error;
  log(message, ...details, (error as Error).message);
}

function isNewGrade(value: string): boolean {
  const timestamp = dateTimestamp(value);
  const startOfWindow = new Date();
  startOfWindow.setHours(0, 0, 0, 0);
  startOfWindow.setDate(startOfWindow.getDate() - 6);
  return timestamp >= startOfWindow.getTime() && timestamp <= Date.now();
}

function AppButton({
  label,
  onPress,
  icon,
  disabled = false,
  secondary = false
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed
      ]}
    >
      {icon}
      <Text style={[styles.buttonText, secondary && styles.buttonTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

function EmptyLine({ children }: { children: string }) {
  return <Text style={styles.emptyLine}>{children}</Text>;
}

function PupilHeading({
  pupil,
  detail,
  context = "journal"
}: {
  pupil: EdPupil;
  detail?: string;
  context?: "journal" | "compte";
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const name = [pupil.prenom, pupil.nom].filter(Boolean).join(" ") || `Élève ${pupil.id}`;
  const photoUri = normalizePhotoUri(pupil.photo);
  useEffect(() => setPhotoFailed(false), [photoUri]);

  const initials = (pupil.prenom?.[0] || pupil.nom?.[0] || "E").toUpperCase();

  return (
    <View style={styles.pupilHeading}>
      {photoUri && !photoFailed ? (
        <Image
          source={{ uri: photoUri }}
          resizeMode="cover"
          onLoad={() => console.info("[PHOTO-RENDER] Image chargée.", { context, ...photoUriDiagnostic(photoUri) })}
          onError={(event) => {
            console.warn("[PHOTO-RENDER] Échec du chargement de l’image.", {
              context,
              ...photoUriDiagnostic(photoUri),
              error: sanitizePhotoError(event.nativeEvent.error)
            });
            setPhotoFailed(true);
          }}
          style={styles.pupilPhoto}
        />
      ) : (
        <View style={[styles.pupilPhoto, styles.pupilPhotoFallback]}>
          <Text style={styles.initialsText}>{initials}</Text>
        </View>
      )}
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle}>{name}</Text>
        {!!detail && <Text style={styles.rowDetail}>{detail}</Text>}
      </View>
    </View>
  );
}

function ChildProfileAvatar({
  photo,
  active,
  name
}: {
  photo?: string;
  active: boolean;
  name: string;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const photoUri = normalizePhotoUri(photo);
  useEffect(() => setPhotoFailed(false), [photoUri]);
  if (photoUri && !photoFailed) {
    return (
      <Image
        source={{ uri: photoUri }}
        resizeMode="cover"
        onLoad={() => console.info("[PHOTO-RENDER] Avatar chargé.", photoUriDiagnostic(photoUri))}
        onError={(event) => {
          console.warn("[PHOTO-RENDER] Échec du chargement de l’avatar.", {
            ...photoUriDiagnostic(photoUri),
            error: sanitizePhotoError(event.nativeEvent.error)
          });
          setPhotoFailed(true);
        }}
        style={styles.childChipPhoto}
      />
    );
  }
  return (
    <>
      <UserRound size={13} color={active ? "#FFFFFF" : palette.green} />
      <Text style={[styles.childChipText, active && styles.childChipTextActive]}>{name}</Text>
    </>
  );
}

function homeworkDocument(content: string): string {
  const pageRule = content.match(/@page\s*\{[^}]*\}/i)?.[0] ?? "";
  const body = pageRule ? content.replace(pageRule, "") : content;
  const documentContent = /<html[\s>]/i.test(body)
    ? body.replace(/<head\b[^>]*>/i, `$&<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes" /><style>${pageRule}</style>`)
    : `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes" /><style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #1D3330; padding: 16px; line-height: 1.5; overflow-wrap: anywhere; }
      img, table { max-width: 100%; }
      table { border-collapse: collapse; }
      ${pageRule}
    </style></head><body>${body}</body></html>`;
  return documentContent;
}

type JournalSection = "courses" | "homeworks" | "grades";
const JOURNAL_SECTIONS: { id: JournalSection; label: string; unit: string; Icon: typeof BookOpen; color: "green" | "coral" | "blue"; tint: "summaryMint" | "summaryPeach" | "summaryBlue" }[] = [
  { id: "courses", label: "Emploi du temps", unit: "cours", Icon: BookOpen, color: "green", tint: "summaryMint" },
  { id: "homeworks", label: "Devoirs", unit: "devoirs", Icon: ClipboardList, color: "coral", tint: "summaryPeach" },
  { id: "grades", label: "Notes", unit: "élèves avec note", Icon: GraduationCap, color: "blue", tint: "summaryBlue" }
];

function ChildProfilesBar({
  children,
  providerAccounts,
  activeChildId,
  onSelectChild,
  onAddChild,
  showAll = true
}: {
  children: ChildProfile[];
  providerAccounts: ProviderAccount[];
  activeChildId: string | null;
  onSelectChild: (id: string | null) => void;
  onAddChild: () => void;
  showAll?: boolean;
}) {
  return (
    <View style={styles.childBarContainer}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.childBarScroll}>
        {showAll && (
          <Pressable
            onPress={() => onSelectChild(null)}
            style={[
              styles.childChip,
              activeChildId === null && styles.childChipActive
            ]}
          >
            <Text style={[styles.childChipText, activeChildId === null && styles.childChipTextActive]}>
              Tous les élèves
            </Text>
          </Pressable>
        )}

        {children.map((child) => {
          const active = activeChildId === child.id;
          const photo = childProfilePhoto(child, providerAccounts);
          return (
            <Pressable
              key={child.id}
              accessibilityRole="button"
              accessibilityLabel={`${child.firstName || "Enfant"} ${child.lastName || ""}`.trim()}
              accessibilityState={{ selected: active }}
              onPress={() => onSelectChild(child.id)}
              style={[
                styles.childChip,
                active && styles.childChipActive,
                !!normalizePhotoUri(photo) && styles.childChipWithPhoto
              ]}
            >
              <ChildProfileAvatar photo={photo} active={active} name={child.firstName || "Enfant"} />
            </Pressable>
          );
        })}

        {onAddChild && (
          <Pressable onPress={onAddChild} style={styles.childChipAdd}>
            <Plus size={13} color={palette.green} />
            <Text style={styles.childChipAddText}>Services</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const PROVIDER_LABELS: Record<ProviderType, string> = {
  ecoleDirecte: "École Directe",
  skolengo: "Skolengo",
  pronote: "Pronote"
};

function SettingStepper({
  title,
  detail,
  value,
  min,
  max,
  unit,
  onChange
}: {
  title: string;
  detail: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.settingsToggleRow}>
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Réduire : ${title}`}
          disabled={value <= min}
          onPress={() => onChange(Math.max(min, value - 1))}
          style={styles.stepButton}
        >
          <Minus size={16} color={value <= min ? palette.muted : palette.ink} />
        </Pressable>
        <Text accessibilityLabel={`${value} ${unit}`} style={styles.stepValue}>{value}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Augmenter : ${title}`}
          disabled={value >= max}
          onPress={() => onChange(Math.min(max, value + 1))}
          style={styles.stepButton}
        >
          <Plus size={16} color={value >= max ? palette.muted : palette.ink} />
        </Pressable>
      </View>
    </View>
  );
}

function ProviderSourceSelector({
  child,
  accounts,
  onChange
}: {
  child: ChildProfile;
  accounts: ProviderAccount[];
  onChange: (domain: DomainType, provider: ProviderType | null) => void;
}) {
  const domains: { id: DomainType; label: string }[] = [
    { id: "courses", label: "Emploi du temps" },
    { id: "homeworks", label: "Devoirs" },
    { id: "grades", label: "Notes" },
    { id: "photo", label: "Photo de profil" },
    { id: "messages", label: "Messagerie" }
  ];
  const availableProviders = (Object.keys(child.links) as ProviderType[]).filter((provider) => {
    const link = child.links[provider];
    return !!link && accounts.some((account) => account.id === link.accountId);
  });

  return (
    <View style={styles.childSourcesCard}>
      {domains.map(({ id, label }) => (
        <View key={id} style={styles.childSourceRow}>
          <Text style={styles.childSourceLabel}>{label}</Text>
          <View style={styles.domainChoiceRow}>
              {[...availableProviders, null].map((provider) => {
                const selected = child.sources[id] === provider;
                const providerLabel = provider ? PROVIDER_LABELS[provider] : "Désactivé";
                return (
                  <Pressable
                    key={provider}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => onChange(id, provider)}
                    style={[styles.domainChoice, selected && styles.domainChoiceSelected]}
                  >
                    <Text style={[styles.domainChoiceText, selected && styles.domainChoiceTextSelected]}>
                      {providerLabel}
                    </Text>
                  </Pressable>
                );
              })}
          </View>
        </View>
      ))}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
      <PhotoWebViewHost />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [tab, setTab] = useState<Tab>("journal");
  const [childrenProfiles, setChildrenProfiles] = useState<ChildProfile[]>([]);
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[]>([]);
  const [activeChildId, setActiveChildId] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderType>("ecoleDirecte");
  const [pronoteLoginOpen, setPronoteLoginOpen] = useState(false);
  const [pronoteLoginError, setPronoteLoginError] = useState("");
  const [pronoteSsoOpen, setPronoteSsoOpen] = useState(false);
  const [pronoteStartUrl, setPronoteStartUrl] = useState("");
  const [schoolSearch, setSchoolSearch] = useState("");
  const [skolengoSchools, setSkolengoSchools] = useState<Awaited<ReturnType<typeof searchSkolengoSchools>>>([]);
  const [selectedDay, setSelectedDay] = useState(() => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    return date;
  });
  const [preferences, setPreferences] = useState<ReminderPreferences>(defaultPreferences);
  const [data, setData] = useState<SchoolData[] | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberCredentials, setRememberCredentials] = useState(Platform.OS === "web");
  const [twoFactorFactors, setTwoFactorFactors] = useState<{ cn: string; cv: string } | undefined>();
  const [backgroundSyncEnabled, setBackgroundSyncEnabled] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [backgroundSyncStatus, setBackgroundSyncStatus] = useState<BackgroundSyncStatus | null>(null);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedHomework, setSelectedHomework] = useState<{ student: EdPupil; homework: HomeworkItem } | null>(null);
  const [schoolZone, setSchoolZone] = useState<SchoolZone>("C");
  const [holidaysOpen, setHolidaysOpen] = useState(false);
  const [messagesByChild, setMessagesByChild] = useState<ChildMessages[] | null>(null);
  const [messagesBusy, setMessagesBusy] = useState(false);
  const [messagesSyncedAt, setMessagesSyncedAt] = useState<string | null>(null);
  const [expandedMessage, setExpandedMessage] = useState<string | null>(null);

  useEffect(() => {
    void getSavedZone().then(setSchoolZone);
  }, []);

  const changeSchoolZone = (zone: SchoolZone) => {
    setSchoolZone(zone);
    void saveZone(zone);
  };
  const sessionRef = useRef<EdSession | null>(null);
  const providerSessionsRef = useRef(new Map<string, ProviderSession>());
  const providerAccountsRef = useRef(providerAccounts);
  const childrenProfilesRef = useRef(childrenProfiles);
  const preferencesRef = useRef(preferences);
  const selectedDayRef = useRef(selectedDay);
  const contentScrollRef = useRef<ScrollView>(null);
  const journalSectionOffsets = useRef<Partial<Record<JournalSection, number>>>({});
  providerAccountsRef.current = providerAccounts;
  childrenProfilesRef.current = childrenProfiles;
  preferencesRef.current = preferences;
  selectedDayRef.current = selectedDay;

  const activeAccountFor = (provider: ProviderType) => providerAccountsRef.current.find((account) =>
    account.provider === provider && providerSessionsRef.current.has(account.id)
  );

  const dataRef = useRef<SchoolData[] | null>(null);
  dataRef.current = data;

  const selectActiveChild = (id: string | null) => {
    setActiveChildId(id);
    void SecureStore.setItemAsync(ACTIVE_CHILD_KEY, id || "");
  };

  const normalizeIdentity = (value: string) => value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("fr-FR");
  const normalizePersonName = (value: string) => normalizeIdentity(value).split(" ").sort().join(" ");

  const mergeProviderStudents = (
    currentChildren: ChildProfile[],
    provider: ProviderType,
    accountId: string,
    students: ProviderStudent[]
  ): ChildProfile[] => {
    let merged = [...currentChildren];
    for (const student of students) {
      const fullName = normalizePersonName(`${student.firstName} ${student.lastName}`);
      const existingIndex = merged.findIndex((child) =>
        normalizePersonName(`${child.firstName} ${child.lastName}`) === fullName &&
        (!child.links[provider] || child.links[provider]?.accountId === accountId)
      );
      const existing = existingIndex >= 0 ? merged[existingIndex] : undefined;
      const links = {
        ...existing?.links,
        [provider]: { accountId, studentId: student.id }
      };
      const sources: Record<DomainType, ProviderType | null> = {
        courses: existing?.sources?.courses ?? provider,
        homeworks: existing?.sources?.homeworks ?? provider,
        grades: existing?.sources?.grades ?? provider,
        photo: existing?.sources?.photo ?? provider,
        messages: existing?.sources?.messages ?? provider
      };
      for (const domain of Object.keys(sources) as DomainType[]) {
        const source = sources[domain];
        if (source && !links[source]) sources[domain] = provider;
      }
      const nextChild: ChildProfile = {
        id: existing?.id || `${provider}-${accountId}-${student.id}`,
        firstName: existing?.firstName || student.firstName,
        lastName: existing?.lastName || student.lastName,
        className: existing?.className || student.className,
        links,
        sources
      };
      if (existingIndex >= 0) merged[existingIndex] = nextChild;
      else merged.push(nextChild);
    }
    return merged;
  };

  const addProviderConnection = async (
    account: ProviderAccount,
    session: ProviderSession,
    remember = rememberCredentials
  ) => {
    const activeAccount = activeAccountFor(account.provider);
    if (activeAccount) {
      const uniqueAccounts = [...new Map(providerAccountsRef.current.map((item) => [item.id, item])).values()];
      if (uniqueAccounts.length !== providerAccountsRef.current.length) {
        providerAccountsRef.current = uniqueAccounts;
        setProviderAccounts(uniqueAccounts);
        await persistProviderAccounts(uniqueAccounts, rememberCredentials);
      }
      setNotice(`${activeAccount.label} possède déjà une session active; elle est conservée.`);
      return childrenProfilesRef.current;
    }
    const replacedAccounts = providerAccountsRef.current.filter((item) =>
      item.provider === account.provider && item.id !== account.id
    );
    const replacedIds = new Set(replacedAccounts.map((item) => item.id));
    const childrenWithoutReplacedAccount = childrenProfilesRef.current.flatMap((child) => {
      const links = { ...child.links };
      if (links[account.provider] && replacedIds.has(links[account.provider]!.accountId)) {
        delete links[account.provider];
      }
      const availableProviders = Object.keys(links) as ProviderType[];
      if (!availableProviders.length) return [];
      const sources = { ...child.sources };
      for (const domain of Object.keys(sources) as DomainType[]) {
        const source = sources[domain];
        if (source && !links[source]) sources[domain] = availableProviders[0];
      }
      return [{ ...child, links, sources }];
    });
    const nextAccounts = [
      ...providerAccountsRef.current.filter((item) => item.provider !== account.provider),
      account
    ];
    const nextChildren = mergeProviderStudents(
      childrenWithoutReplacedAccount,
      account.provider,
      account.id,
      account.students
    );
    providerSessionsRef.current.set(account.id, session);
    setMessagesByChild(null);
    for (const replacedAccount of replacedAccounts) {
      providerSessionsRef.current.delete(replacedAccount.id);
      await SecureStore.deleteItemAsync(providerTokenKey(replacedAccount.id));
    }
    providerAccountsRef.current = nextAccounts;
    childrenProfilesRef.current = nextChildren;
    setProviderAccounts(nextAccounts);
    setChildrenProfiles(nextChildren);
    if (!nextChildren.some((child) => child.id === activeChildId)) {
      selectActiveChild(nextChildren[0]?.id || null);
    }
    if (remember && account.refreshToken) {
      await SecureStore.setItemAsync(providerTokenKey(account.id), account.refreshToken);
    }
    await persistProviderAccounts(nextAccounts, remember);
    if (!remember && backgroundSyncEnabled) {
      await disableBackgroundSync();
      setBackgroundSyncEnabled(false);
    }
    await SecureStore.setItemAsync(CHILDREN_PROFILES_KEY, JSON.stringify(nextChildren));
    setNotice(`${account.label} connecté : ${account.students.length} enfant${account.students.length === 1 ? "" : "s"} trouvé${account.students.length === 1 ? "" : "s"}.${!remember && backgroundSyncEnabled ? " Synchronisation périodique désactivée : ce compte n'est pas mémorisé." : ""}`);
    return nextChildren;
  };

  const changeDomainSource = async (childId: string, domain: DomainType, provider: ProviderType | null) => {
    const nextChildren = childrenProfiles.map((child) => child.id === childId
      ? { ...child, sources: { ...child.sources, [domain]: provider } }
      : child);
    setChildrenProfiles(nextChildren);
    childrenProfilesRef.current = nextChildren;
    await SecureStore.setItemAsync(CHILDREN_PROFILES_KEY, JSON.stringify(nextChildren));
    setMessagesByChild(null);
    if (domain === "messages") return;
    const nextData = await fetchConnectedChildrenData(nextChildren, selectedDayRef.current);
    setData(nextData);
    selectActiveChild(null);
    await scheduleDailyReminders(preferences, nextData).catch(() => false);
  };

  const removeProviderAccount = async (account: ProviderAccount) => {
    const nextAccounts = providerAccounts.filter((item) => item.id !== account.id);
    providerSessionsRef.current.delete(account.id);
    await Promise.all(account.students.map((student) => forgetPhoto(photoCacheKey(account.provider, student.id))));
    const nextChildren = childrenProfiles.flatMap((child) => {
      const links = { ...child.links };
      if (links[account.provider]?.accountId === account.id) delete links[account.provider];
      const availableProviders = Object.keys(links) as ProviderType[];
      if (!availableProviders.length) return [];
      const sources = { ...child.sources };
      for (const domain of Object.keys(sources) as DomainType[]) {
        const source = sources[domain];
        if (source && !links[source]) sources[domain] = availableProviders[0];
      }
      return [{ ...child, links, sources }];
    });
    providerAccountsRef.current = nextAccounts;
    childrenProfilesRef.current = nextChildren;
    setProviderAccounts(nextAccounts);
    setChildrenProfiles(nextChildren);
    setMessagesByChild(null);
    if (account.provider === "ecoleDirecte" && account.username === username) {
      sessionRef.current = null;
      setData(null);
      await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
      await SecureStore.deleteItemAsync(DEVICE_KEY);
      await disableBackgroundSync();
      setBackgroundSyncEnabled(false);
    }
    if (!nextChildren.some((child) => child.id === activeChildId)) {
      selectActiveChild(nextChildren[0]?.id || null);
    }
    await SecureStore.deleteItemAsync(providerTokenKey(account.id));
    await persistProviderAccounts(nextAccounts, rememberCredentials);
    await SecureStore.setItemAsync(CHILDREN_PROFILES_KEY, JSON.stringify(nextChildren));
    setNotice(`${account.label} déconnecté.`);
  };

  const registerEcoleDirecteConnection = async (
    session: EdSession,
    currentUsername: string,
    uuid: string,
    remember = rememberCredentials
  ): Promise<ChildProfile[]> => {
    const parentName = [session.student?.prenom, session.student?.nom].filter(Boolean).join(" ") || currentUsername;
    const students = (session.pupils || []).map((pupil) => {
      return {
        id: String(pupil.id),
        firstName: pupil.prenom || "",
        lastName: pupil.nom || "",
        className: pupil.classe?.libelle || pupil.classe?.code || "",
        photo: pupil.photo
      };
    });
    return addProviderConnection({
      id: `ecoleDirecte:${normalizeIdentity(currentUsername)}`,
      provider: "ecoleDirecte",
      username: currentUsername,
      label: parentName,
      parentName,
      deviceUUID: uuid,
      refreshToken: session.accessToken,
      students
    }, session, remember);
  };

  // Picks up tokens rotated elsewhere (background task) and reopens dropped Pronote/Skolengo sessions.
  const renewProviderSessions = async (): Promise<Map<string, string>> => {
    const connectionErrors = new Map<string, string>();
    for (const saved of await readProviderAccounts()) {
      const current = providerAccountsRef.current.find((account) => account.id === saved.id);
      if (!current || !saved.refreshToken || saved.provider === "ecoleDirecte") continue;
      if (saved.refreshToken === current.refreshToken && providerSessionsRef.current.has(saved.id)) continue;
      try {
        if (saved.provider === "pronote") {
          const restored = await restorePronote(saved.refreshToken, (token) =>
            SecureStore.setItemAsync(providerTokenKey(saved.id), token));
          providerSessionsRef.current.set(saved.id, restored.session);
          current.refreshToken = restored.refreshToken;
          current.students = restored.students;
        } else if (saved.school) {
          const restored = await restoreSkolengoLogin(saved.refreshToken, saved.school);
          await SecureStore.setItemAsync(providerTokenKey(saved.id), restored.account.refreshToken);
          providerSessionsRef.current.set(saved.id, restored.account);
          current.refreshToken = restored.account.refreshToken;
        }
      } catch (error) {
        console.warn("[APP] Could not renew provider session:", error);
        providerSessionsRef.current.delete(saved.id);
        connectionErrors.set(saved.id, error instanceof Error ? error.message : String(error));
      }
    }
    return connectionErrors;
  };

  // Without a date, the sync shows the first day (today included) that still has a course to come.
  const fetchConnectedChildrenData = async (
    childrenToFetch = childrenProfiles,
    timetableDate?: Date,
    homeworkDays = preferencesRef.current.homeworkDays
  ): Promise<SchoolData[]> => {
    const connectionErrors = await renewProviderSessions();
    let day = timetableDate;
    if (!day) {
      day = await findFirstCourseDay(childrenToFetch, providerAccountsRef.current, providerSessionsRef.current);
      selectedDayRef.current = day;
      setSelectedDay(day);
    }
    return syncChildren(childrenToFetch, providerAccountsRef.current, providerSessionsRef.current, day, homeworkDays, connectionErrors);
  };

  const refreshConnectedChildren = async (timetableDate?: Date) => {
    const nextData = await fetchConnectedChildrenData(childrenProfiles, timetableDate);
    setData(nextData);
    selectActiveChild(null);
    await scheduleDailyReminders(preferences, nextData).catch(() => false);
    return nextData;
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([
      SecureStore.getItemAsync(PREFS_KEY),
      SecureStore.getItemAsync(CREDENTIALS_KEY),
      SecureStore.getItemAsync(BACKGROUND_SYNC_ENABLED_KEY),
      SecureStore.getItemAsync(CHILDREN_PROFILES_KEY),
      SecureStore.getItemAsync(ACTIVE_CHILD_KEY),
      SecureStore.getItemAsync(PROVIDER_ACCOUNTS_KEY)
    ]).then(async ([savedPreferences, savedCredentials, backgroundSyncFlag, savedChildren, savedActiveChild, savedProviderAccounts]) => {
      if (!mounted) return;
      let restoredChildren: ChildProfile[] = [];
      if (savedChildren) {
        try {
          restoredChildren = (JSON.parse(savedChildren) as ChildProfile[]).map(withDefaultSources);
        } catch {}
      }
      let restoredAccounts: ProviderAccount[] = [];
      let duplicateAccountRecords = false;
      if (savedProviderAccounts) {
        try {
          const savedAccounts = JSON.parse(savedProviderAccounts) as ProviderAccount[];
          const uniqueAccounts = [...new Map(savedAccounts.map((account) => [
            `${account.provider}:${account.id}`,
            account
          ])).values()];
          duplicateAccountRecords = uniqueAccounts.length !== savedAccounts.length;
          restoredAccounts = await Promise.all(uniqueAccounts.map(async (account) => ({
            ...account,
            refreshToken: await SecureStore.getItemAsync(providerTokenKey(account.id)) || undefined
          })));
        } catch {
          await SecureStore.deleteItemAsync(PROVIDER_ACCOUNTS_KEY);
        }
      }
      let hasRestoredSession = false;
      for (const savedAccount of restoredAccounts) {
        if (!savedAccount.refreshToken) continue;
        try {
          if (savedAccount.provider === "pronote" && savedAccount.url) {
            const restored = await restorePronote(savedAccount.refreshToken, (token) =>
              SecureStore.setItemAsync(providerTokenKey(savedAccount.id), token));
            providerSessionsRef.current.set(savedAccount.id, restored.session);
            savedAccount.refreshToken = restored.refreshToken;
            savedAccount.students = restored.students;
            savedAccount.parentName = restored.parentName;
            savedAccount.label = restored.parentName;
          } else if (savedAccount.provider === "skolengo" && savedAccount.school) {
            const restored = await restoreSkolengoLogin(savedAccount.refreshToken, savedAccount.school);
            providerSessionsRef.current.set(savedAccount.id, restored.account);
            savedAccount.refreshToken = restored.account.refreshToken;
            await SecureStore.setItemAsync(providerTokenKey(savedAccount.id), savedAccount.refreshToken);
            savedAccount.students = restored.students;
            savedAccount.parentName = [restored.account.firstName, restored.account.lastName].filter(Boolean).join(" ") || "Compte parent";
            savedAccount.label = savedAccount.parentName;
          } else {
            continue;
          }
          restoredChildren = mergeProviderStudents(
            restoredChildren,
            savedAccount.provider,
            savedAccount.id,
            savedAccount.students
          );
          hasRestoredSession = true;
        } catch (error) {
          console.warn(`[APP] Could not restore ${savedAccount.label}:`, error);
        }
      }
      if (!mounted) return;
      providerAccountsRef.current = restoredAccounts;
      childrenProfilesRef.current = restoredChildren;
      setProviderAccounts(restoredAccounts);
      setChildrenProfiles(restoredChildren);
      if (savedActiveChild && restoredChildren.some((child) => child.id === savedActiveChild)) {
        setActiveChildId(savedActiveChild);
      } else if (restoredChildren[0]) {
        setActiveChildId(restoredChildren[0].id);
      }
      if (hasRestoredSession) {
        setRememberCredentials(true);
        await persistProviderAccounts(restoredAccounts, true);
        await SecureStore.setItemAsync(CHILDREN_PROFILES_KEY, JSON.stringify(restoredChildren));
      } else if (duplicateAccountRecords) {
        await persistProviderAccounts(restoredAccounts, restoredAccounts.some((account) => !!account.refreshToken));
      }
      let activePrefs = defaultPreferences;
      if (savedPreferences) {
        try {
          activePrefs = { ...defaultPreferences, ...JSON.parse(savedPreferences) };
          setPreferences(activePrefs);
        } catch {
          setPreferences(defaultPreferences);
        }
      }
      if (savedCredentials) {
        try {
          const saved = JSON.parse(savedCredentials) as {
            username: string;
            password: string;
            accessToken?: string;
            accountType?: string;
            factors?: { cn: string; cv: string };
          };
          setUsername(saved.username);
          setPassword(saved.password || "");
          setTwoFactorFactors(saved.factors);
          setRememberCredentials(true);
          if (saved.username && (saved.password || saved.accessToken)) {
            await performAutoLogin(saved.username, saved.password || "", activePrefs, saved.factors, saved.accessToken, saved.accountType);
          }
        } catch {
          void SecureStore.deleteItemAsync(CREDENTIALS_KEY);
        }
      }
      if (hasRestoredSession && restoredChildren.length) {
        try {
          const restoredData = await fetchConnectedChildrenData(
            restoredChildren,
            undefined,
            activePrefs.homeworkDays
          );
          setData(restoredData);
          selectActiveChild(null);
          await scheduleDailyReminders(activePrefs, restoredData).catch(() => false);
        } catch (error) {
          setNotice(`Synchronisation impossible : ${(error as Error).message}`);
        }
      }
      if (backgroundSyncFlag === "true") {
        void enableBackgroundSync().then(() => setBackgroundSyncEnabled(true)).catch((error) => {
          setBackgroundSyncEnabled(false);
          setNotice(`Synchronisation périodique indisponible : ${(error as Error).message}`);
        });
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") return;
      if (providerAccountsRef.current.some((account) => account.provider !== "ecoleDirecte")) {
        void fetchConnectedChildrenData(
          childrenProfilesRef.current,
          undefined,
          preferencesRef.current.homeworkDays
        ).then(async (latestData) => {
          setData(latestData);
          selectActiveChild(null);
          await scheduleDailyReminders(preferencesRef.current, latestData).catch(() => false);
        }).catch((error) => console.warn("[APP] Could not refresh provider data:", error));
        return;
      }
      void Promise.all([readBackgroundSyncData(), getBackgroundSyncStatus()])
        .then(([backgroundData, status]) => {
          setBackgroundSyncStatus(status);
          if (!backgroundData?.length) return;
          const currentTimestamp = Math.max(0, ...(dataRef.current || []).map((entry) => Date.parse(entry.syncedAt) || 0));
          const backgroundTimestamp = Math.max(...backgroundData.map((entry) => Date.parse(entry.syncedAt) || 0));
          if (backgroundTimestamp > currentTimestamp) {
            setData(backgroundData);
            selectActiveChild(null);
            if (status.selectedDay) {
              const backgroundDay = new Date(status.selectedDay);
              if (!Number.isNaN(backgroundDay.getTime())) setSelectedDay(backgroundDay);
            }
          }
        })
        .catch((error) => console.warn("[BACKGROUND-SYNC] Could not load background status:", error));
    });
    return () => subscription.remove();
  }, []);

  const performAutoLogin = async (
    userToUse: string,
    passToUse: string,
    prefsToUse: ReminderPreferences,
    factors?: { cn: string; cv: string },
    savedAccessToken?: string,
    accountType = "E"
  ) => {
    console.log("[APP] Starting auto-login...");
    setBusy(true);
    setNotice("");
    const session = createEdSession();
    const savedUuid = await SecureStore.getItemAsync(DEVICE_KEY);
    const uuid = savedUuid || Crypto.randomUUID();
    if (!savedUuid) await SecureStore.setItemAsync(DEVICE_KEY, uuid);
    try {
      if (savedAccessToken) {
        await relogin(session, userToUse.trim(), uuid, savedAccessToken, accountType, factors);
      } else {
        await login(session, userToUse.trim(), passToUse, uuid, factors);
      }
      await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify({
        username: userToUse.trim(), password: passToUse, accessToken: session.accessToken,
        accountType: session.student?.typeCompte, factors: session.twoFactorFactors
      }));
      sessionRef.current = session;
      const connectedChildren = await registerEcoleDirecteConnection(session, userToUse.trim(), uuid, true);
      console.log("[APP] Auto-login succeeded. Fetching school data...");
      const latestData = await fetchConnectedChildrenData(connectedChildren, undefined, prefsToUse.homeworkDays);
      setData(latestData);
      selectActiveChild(null);
      await scheduleDailyReminders(prefsToUse, latestData).catch(() => false);
      console.log("[APP] Auto-login & sync complete!");
    } catch (error) {
      logLoginFailure("[APP] Auto-login failed:", error);
      if ((error as { code?: number })?.code === 250) {
        try {
          const securityChallenge = await fetchLoginChallenge(session);
          setChallenge({
            session,
            username: userToUse.trim(),
            password: passToUse,
            uuid,
            ...securityChallenge
          });
          setTab("compte");
          setNotice("Une vérification École Directe est nécessaire.");
        } catch (challengeError) {
          logLoginFailure("[APP] Auto-login challenge failed:", challengeError);
          setNotice(`Connexion automatique impossible : ${(challengeError as Error).message}`);
        }
      } else {
        setNotice(`Connexion automatique impossible : ${(error as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const finishConnection = async (
    session: EdSession,
    currentUsername: string,
    currentPassword: string,
    uuid: string
  ) => {
    console.log("[APP] Finishing connection...");
    const activeAccount = activeAccountFor("ecoleDirecte");
    if (activeAccount) {
      setChallenge(null);
      setNotice(`${activeAccount.label} possède déjà une session active; elle est conservée.`);
      return;
    }
    sessionRef.current = session;
    const connectedChildren = await registerEcoleDirecteConnection(session, currentUsername, uuid);
    const account = session.student;
    setTwoFactorFactors(session.twoFactorFactors);
    setChallenge(null);
    if (rememberCredentials) {
      await SecureStore.setItemAsync(
        CREDENTIALS_KEY,
        JSON.stringify({
          username: currentUsername,
          password: currentPassword,
          accessToken: session.accessToken,
          accountType: account?.typeCompte,
          factors: session.twoFactorFactors
        })
      );
      await SecureStore.setItemAsync(DEVICE_KEY, uuid);
    } else {
      await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
      await SecureStore.deleteItemAsync(DEVICE_KEY);
      setTwoFactorFactors(undefined);
      if (backgroundSyncEnabled) {
        await disableBackgroundSync();
        setBackgroundSyncEnabled(false);
      }
    }
    try {
      console.log("[APP] Fetching school data after login...");
      const latestData = await fetchConnectedChildrenData(connectedChildren, undefined, preferences.homeworkDays);
      setData(latestData);
      await scheduleDailyReminders(preferences, latestData).catch(() => false);
      const failedPupils = latestData.filter((studentData) => studentData.error);
      setNotice(failedPupils.length
        ? `Synchronisation partielle : ${failedPupils.map(({ student }) => student.prenom || student.nom || `élève ${student.id}`).join(", ")}.`
        : "Compte synchronisé. Les rappels utilisent ces données jusqu'à la prochaine synchronisation.");
      console.log("[APP] Connection and initial sync completed!");
    } catch (error) {
      logLoginFailure("[APP] Sync failed after login:", error);
      setData(null);
      await scheduleDailyReminders(preferences, null).catch(() => false);
      setNotice(`Compte connecté, mais synchronisation impossible : ${(error as Error).message}`);
    }
    selectActiveChild(null);
    setTab("journal");
  };

  const connect = async (
    credentials = { username, password },
    reuseTwoFactorFactors = true
  ) => {
    const currentUsername = credentials.username.trim();
    const currentPassword = credentials.password;
    const activeAccount = activeAccountFor("ecoleDirecte");
    if (activeAccount) {
      setNotice(`${activeAccount.label} possède déjà une session active; elle est conservée.`);
      return;
    }
    console.log("[APP] User initiated login...");
    if (!currentUsername || !currentPassword) {
      setNotice("Renseigne ton identifiant et ton mot de passe.");
      return;
    }
    setBusy(true);
    setNotice("");
    const session = createEdSession();
    const uuid = (await SecureStore.getItemAsync(DEVICE_KEY)) || Crypto.randomUUID();
    try {
      await login(session, currentUsername, currentPassword, uuid, reuseTwoFactorFactors ? twoFactorFactors : undefined);
      await finishConnection(session, currentUsername, currentPassword, uuid);
    } catch (error) {
      if ((error as { code?: number })?.code === 250) {
        console.log("[APP] Initial login requires 2FA (API code 250); fetching the security question.");
        try {
          const securityChallenge = await fetchLoginChallenge(session);
          setChallenge({
            session,
            username: currentUsername,
            password: currentPassword,
            uuid,
            ...securityChallenge
          });
          setNotice("Une vérification École Directe est nécessaire.");
        } catch (challengeError) {
          logLoginFailure("[APP] Failed to fetch the 2FA question (GET doubleauth.awp):", challengeError);
          setNotice(`Connexion impossible : ${(challengeError as Error).message}`);
        }
      } else {
        logLoginFailure(`[APP] Initial login failed (POST login.awp, code ${(error as { code?: number }).code ?? "unknown"}):`, error);
        setNotice(`Connexion impossible : ${(error as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const connectPronoteAccount = () => {
    const activeAccount = activeAccountFor("pronote");
    if (activeAccount) {
      setNotice(`${activeAccount.label} possède déjà une session active; elle est conservée.`);
      return;
    }
    setPronoteLoginError("");
    setPronoteLoginOpen(true);
  };

  const reconnectAccount = async (account: ProviderAccount) => {
    if (providerSessionsRef.current.has(account.id)) return;
    if (account.provider === "pronote") {
      setPronoteLoginError("");
      setPronoteLoginOpen(true);
    } else if (account.provider === "skolengo") {
      if (account.school) {
        await connectSkolengoAccount(account.school as NonNullable<SkolengoLoginStart>["school"]);
      } else {
        setNotice("Recherche ton établissement Skolengo pour te reconnecter.");
      }
    } else if (username.trim() && password) {
      await connect({ username, password });
    } else {
      setNotice("Saisis ton identifiant et ton mot de passe École Directe pour te reconnecter.");
    }
  };

  const startPronoteSso = () => {
    const base = pronoteBaseUrl(pronoteStartUrl);
    if (!base) {
      setPronoteLoginError("Saisis l’adresse Pronote de l’établissement, de la forme https://…/pronote");
      return;
    }
    setPronoteStartUrl(base);
    setPronoteLoginError("");
    setPronoteSsoOpen(true);
  };

  const finishPronoteLogin = async (capture: PronoteSsoCapture) => {
    setPronoteSsoOpen(false);
    const activeAccount = activeAccountFor("pronote");
    if (activeAccount) {
      setPronoteLoginOpen(false);
      setNotice(`${activeAccount.label} possède déjà une session active; elle est conservée.`);
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const accountId = `pronote:${normalizeIdentity(capture.url)}:${normalizeIdentity(capture.username)}`;
      const result = await connectPronoteSso(capture, (token) =>
        SecureStore.setItemAsync(providerTokenKey(accountId), token));
      const nextChildren = await addProviderConnection({
        id: accountId,
        provider: "pronote",
        username: result.parentName,
        label: result.parentName,
        parentName: result.parentName,
        url: result.url,
        refreshToken: result.refreshToken,
        students: result.students
      }, result.session, true);
      setRememberCredentials(true);
      setPronoteLoginOpen(false);
      setTab("journal");
      void fetchConnectedChildrenData(nextChildren).then(async (nextData) => {
        setData(nextData);
        selectActiveChild(null);
        await scheduleDailyReminders(preferences, nextData).catch(() => false);
      }).catch((error) => {
        setNotice(`Connexion enregistrée, synchronisation impossible : ${(error as Error).message}`);
      });
    } catch (error) {
      setPronoteLoginError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const findSkolengoSchools = async () => {
    if (!schoolSearch.trim()) {
      setNotice("Saisis le nom de l’établissement Skolengo.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const results = await searchSkolengoSchools(schoolSearch.trim());
      setSkolengoSchools(results);
      if (!results.length) setNotice("Aucun établissement trouvé.");
    } catch (error) {
      setNotice(`Recherche Skolengo impossible : ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const connectSkolengoAccount = async (school: NonNullable<SkolengoLoginStart>["school"]) => {
    const activeAccount = activeAccountFor("skolengo");
    if (activeAccount) {
      setNotice(`${activeAccount.label} possède déjà une session active; elle est conservée.`);
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const start = await startSkolengoLogin(school);
      const result = await WebBrowser.openAuthSessionAsync(
        start.flow.loginURL,
        "skoapp-prod://sign-in-callback"
      );
      if (result.type !== "success" || !result.url) {
        setNotice("Connexion Skolengo annulée.");
        return;
      }
      const { account, students } = await finishSkolengoLogin(start.flow, result.url);
      const accountId = `skolengo:${school.id}:${account.userId}`;
      const nextChildren = await addProviderConnection({
        id: accountId,
        provider: "skolengo",
        username: account.firstName,
        label: [account.firstName, account.lastName].filter(Boolean).join(" ") || "Compte parent",
        parentName: [account.firstName, account.lastName].filter(Boolean).join(" ") || "Compte parent",
        schoolId: school.id,
        schoolName: school.name,
        emsCode: school.emsCode,
        school,
        refreshToken: account.refreshToken,
        students
      }, account);
      const nextData = await fetchConnectedChildrenData(nextChildren);
      setData(nextData);
      selectActiveChild(null);
      await scheduleDailyReminders(preferences, nextData).catch(() => false);
      setSkolengoSchools([]);
      setSchoolSearch("");
      setTab("journal");
    } catch (error) {
      setNotice(`Connexion Skolengo impossible : ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const answerChallenge = async (answer: string) => {
    if (!challenge) return;
    setBusy(true);
    setNotice("");
    let twoFactorAccepted = false;
    try {
      console.log("[APP] Submitting the selected answer (POST doubleauth.awp).");
      const factors = await resolveLoginChallenge(challenge.session, answer);
      twoFactorAccepted = true;
      console.log("[APP] 2FA answer accepted; retrying login with the returned cn/cv factors.");
      try {
        await login(
          challenge.session,
          challenge.username,
          challenge.password,
          challenge.uuid,
          factors
        );
      } catch (loginError) {
        logLoginFailure(`[APP] Final login after 2FA failed (POST login.awp, code ${(loginError as { code?: number }).code ?? "unknown"}):`, loginError);
        setNotice(`Réponse 2FA acceptée, mais la connexion finale a échoué : ${(loginError as Error).message}`);
        return;
      }
      await finishConnection(
        challenge.session,
        challenge.username,
        challenge.password,
        challenge.uuid
      );
    } catch (error) {
      if (twoFactorAccepted) {
        logLoginFailure("[APP] Account finalization failed after successful 2FA login:", error);
        setNotice(`Connexion réussie, mais finalisation impossible : ${(error as Error).message}`);
      } else {
        logLoginFailure(`[APP] 2FA answer submission failed (POST doubleauth.awp, code ${(error as { code?: number }).code ?? "unknown"}):`, error);
        setNotice(`Vérification refusée : ${(error as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const loadMessages = async (count = preferencesRef.current.messageCount) => {
    if (!childrenProfilesRef.current.length) return;
    setMessagesBusy(true);
    try {
      const connectionErrors = await renewProviderSessions();
      const result = await syncChildMessages(
        childrenProfilesRef.current,
        providerAccountsRef.current,
        providerSessionsRef.current,
        count,
        connectionErrors
      );
      setMessagesByChild(result);
      setMessagesSyncedAt(new Date().toISOString());
    } catch (error) {
      setNotice(`Messagerie indisponible : ${error instanceof Error ? error.message : String(error)}`);
      setMessagesByChild([]);
    } finally {
      setMessagesBusy(false);
    }
  };

  useEffect(() => {
    if (tab === "messages" && messagesByChild === null && !messagesBusy && childrenProfiles.length) void loadMessages();
  }, [tab, messagesByChild, messagesBusy, childrenProfiles.length]);

  const refreshRef = useRef<(timetableDate?: Date) => Promise<void>>(async () => undefined);
  const homeworkRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (homeworkRefreshTimer.current) clearTimeout(homeworkRefreshTimer.current);
  }, []);

  // Only this setting is written: unsaved reminder times edited in Rappels must stay unsaved.
  const updateDisplaySetting = async (key: "homeworkDays" | "messageCount", value: number) => {
    if (preferencesRef.current[key] === value) return;
    const next = { ...preferencesRef.current, [key]: value };
    preferencesRef.current = next;
    setPreferences(next);
    let stored: ReminderPreferences = defaultPreferences;
    try {
      const saved = await SecureStore.getItemAsync(PREFS_KEY);
      if (saved) stored = { ...defaultPreferences, ...JSON.parse(saved) };
    } catch {}
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify({ ...stored, [key]: value }));
    if (key === "messageCount") {
      setMessagesByChild(null);
      return;
    }
    // Steppers are tapped repeatedly: resync the journal once the value settles.
    if (homeworkRefreshTimer.current) clearTimeout(homeworkRefreshTimer.current);
    homeworkRefreshTimer.current = setTimeout(() => {
      homeworkRefreshTimer.current = null;
      if (dataRef.current) void refreshRef.current(selectedDayRef.current);
    }, 1200);
  };

  // Without a date (sync button, resume), jump to the first day that still has a course to come.
  const refresh = async (timetableDate?: Date) => {
    console.log("[APP] Refreshing data...");
    if (!sessionRef.current && providerAccounts.length === 0 && username.trim() && password) {
      console.log("[APP] No active session, attempting connect()...");
      await connect();
      return;
    }
    if (!sessionRef.current && (!providerAccounts.length || !childrenProfiles.length)) return;
    setBusy(true);
    setNotice("");
    try {
      const usesExternalProvider = childrenProfiles.some((child) =>
        Object.values(child.sources).some((provider) => provider !== "ecoleDirecte")
      );
      if (!sessionRef.current || usesExternalProvider) {
        if (timetableDate) setSelectedDay(timetableDate);
        const latestData = await refreshConnectedChildren(timetableDate);
        const failedChildren = latestData.filter((entry) => entry.error);
        setNotice(failedChildren.length
          ? `Synchronisation partielle : ${failedChildren.map(({ student }) => student.prenom || student.nom).join(", ")}.`
          : "Synchronisation terminée.");
        return;
      }
      const syncResult = await fetchStudentsSchoolDataWithAutoAdvance(sessionRef.current, preferences.homeworkDays, timetableDate);
      setSelectedDay(syncResult.selectedDay);
      const latestData = syncResult.data;
      setData(latestData);
      await scheduleDailyReminders(preferences, latestData).catch(() => false);
      const expired = latestData.find((studentData) => studentData.errorCode === 520 || studentData.errorCode === 525);
      if (expired) throw Object.assign(new Error(expired.error), { code: expired.errorCode });
      const failedPupils = latestData.filter((studentData) => studentData.error);
      setNotice(failedPupils.length
        ? `Synchronisation partielle : ${failedPupils.map(({ student }) => student.prenom || student.nom || `élève ${student.id}`).join(", ")}.`
        : "Synchronisation terminée.");
      console.log("[APP] Refresh complete!");
    } catch (error) {
      logLoginFailure("[APP] Refresh error:", error, "Code:", (error as { code?: number })?.code);
      const errCode = (error as { code?: number })?.code;
      if ((errCode === 520 || errCode === 525) && username.trim() && password) {
        try {
          console.log("[APP] Session expired (520/525). Re-logging in automatically...");
          const session = createEdSession();
          const uuid = (await SecureStore.getItemAsync(DEVICE_KEY)) || Crypto.randomUUID();
          const savedCredentialsRaw = await SecureStore.getItemAsync(CREDENTIALS_KEY);
          const savedCredentials = savedCredentialsRaw
            ? JSON.parse(savedCredentialsRaw) as {
                username: string;
                password: string;
                accessToken?: string;
                accountType?: string;
                factors?: { cn: string; cv: string };
              }
            : undefined;
          const accessToken = savedCredentials?.accessToken || sessionRef.current?.accessToken;
          const accountType = savedCredentials?.accountType || sessionRef.current?.student?.typeCompte || "E";
          const factors = savedCredentials?.factors || twoFactorFactors;
          if (accessToken) {
            await relogin(session, username.trim(), uuid, accessToken, accountType, factors);
          } else {
            await login(session, username.trim(), password, uuid, factors);
          }
          sessionRef.current = session;
          const connectedChildren = await registerEcoleDirecteConnection(
            session,
            username.trim(),
            uuid,
            !!savedCredentialsRaw
          );
          const account = session.student;
          setTwoFactorFactors(session.twoFactorFactors);
          if (savedCredentialsRaw && session.accessToken) {
            await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify({
              ...savedCredentials,
              accessToken: session.accessToken,
              accountType: account?.typeCompte,
              factors: session.twoFactorFactors
            }));
          }
          const latestData = await fetchConnectedChildrenData(connectedChildren, timetableDate, preferences.homeworkDays);
          setData(latestData);
          await scheduleDailyReminders(preferences, latestData).catch(() => false);
          const failedPupils = latestData.filter((studentData) => studentData.error);
          if (failedPupils.length) {
            setNotice(`Synchronisation partielle : ${failedPupils.map(({ student }) => student.prenom || student.nom || `élève ${student.id}`).join(", ")}.`);
            return;
          }
          setNotice("Session renouvelée et synchronisation terminée.");
          console.log("[APP] Automatic re-login & refresh succeeded!");
          return;
        } catch (relogErr) {
          logLoginFailure("[APP] Automatic re-login failed:", relogErr);
        }
      }
      setNotice(`Synchronisation impossible : ${(error as Error).message}`);
    } finally {
      selectActiveChild(null);
      setBusy(false);
    }
  };

  refreshRef.current = refresh;

  const navigateSchedule = async (offset: number) => {
    const nextDay = new Date(selectedDay);
    nextDay.setDate(nextDay.getDate() + offset);
    nextDay.setHours(12, 0, 0, 0);
    setSelectedDay(nextDay);
    if (sessionRef.current || providerAccountsRef.current.length) await refresh(nextDay);
  };

  const savePreferences = async () => {
    const normalizedPrefs: ReminderPreferences = {
      ...preferences,
      classes: { ...preferences.classes, time: normalizeTime(preferences.classes.time) },
      homework: { ...preferences.homework, time: normalizeTime(preferences.homework.time) },
      grades: { ...preferences.grades, time: normalizeTime(preferences.grades.time) }
    };
    setPreferences(normalizedPrefs);
    const times = [normalizedPrefs.classes.time, normalizedPrefs.homework.time, normalizedPrefs.grades.time];
    if (times.some((time) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
      setNotice("Saisis les horaires au format 07:30.");
      return;
    }
    await SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(normalizedPrefs));
    let latestData = data;
    let syncFailed = false;
    const externalSessionActive = providerAccountsRef.current.some((account) =>
      account.provider !== "ecoleDirecte" && providerSessionsRef.current.has(account.id)
    );
    if (externalSessionActive && childrenProfiles.length) {
      try {
        latestData = await fetchConnectedChildrenData(childrenProfiles, selectedDay, normalizedPrefs.homeworkDays);
        setData(latestData);
        selectActiveChild(null);
      } catch {
        latestData = null;
        syncFailed = true;
      }
    } else if (sessionRef.current) {
      try {
        const syncResult = await fetchStudentsSchoolDataWithAutoAdvance(sessionRef.current, normalizedPrefs.homeworkDays, selectedDay);
        setSelectedDay(syncResult.selectedDay);
        latestData = syncResult.data;
        setData(latestData);
        selectActiveChild(null);
      } catch {
        latestData = null;
        syncFailed = true;
      }
    }
    await scheduleDailyReminders(normalizedPrefs, latestData).catch(() => false);
    setNotice(
      `Horaires enregistrés.${syncFailed ? " École Directe n'a pas répondu." : ""}`
    );
  };

  const testNotifications = async () => {
    setBusy(true);
    setNotice("");
    try {
      const result = await sendTestNotifications(preferences, data);
      setNotice(!result.permissionGranted
        ? "Autorise les notifications dans les réglages Android pour effectuer le test."
        : result.sent === 0
          ? "Active au moins un type de rappel pour effectuer le test."
          : `${result.sent} notification${result.sent === 1 ? "" : "s"} de test envoyée${result.sent === 1 ? "" : "s"}.`);
    } catch (error) {
      setNotice(`Test des notifications impossible : ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const checkBackgroundConfiguration = async () => {
    setBusy(true);
    try {
      setBackgroundSyncStatus(await getBackgroundSyncStatus());
    } catch (error) {
      setNotice(`Vérification impossible : ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const updateBackgroundSync = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (enabled) {
        await enableBackgroundSync();
        setBackgroundSyncEnabled(true);
        setNotice("Synchronisation périodique activée. Android peut différer l’exécution pour économiser la batterie.");
      } else {
        await disableBackgroundSync();
        setBackgroundSyncEnabled(false);
        setNotice("Synchronisation périodique désactivée.");
      }
      setBackgroundSyncStatus(await getBackgroundSyncStatus());
    } catch (error) {
      setNotice(`Configuration impossible : ${(error as Error).message}`);
      setBackgroundSyncStatus(await getBackgroundSyncStatus().catch(() => null));
    } finally {
      setBusy(false);
    }
  };

  const updateReminder = (key: "classes" | "homework" | "grades", update: { enabled?: boolean; time?: string }) => {
    setPreferences((current) => ({
      ...current,
      [key]: { ...current[key], ...update }
    }));
  };

  const selectedChild = childrenProfiles.find((child) => child.id === activeChildId);
  const normalizeName = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("fr-FR");
  const visibleData = activeChildId
    ? data?.filter(({ student }) => {
        if (!selectedChild) return false;
        const expectedName = normalizeName(`${selectedChild.firstName} ${selectedChild.lastName}`);
        const pupilName = normalizeName([student.prenom, student.nom].filter(Boolean).join(" "));
        return expectedName === pupilName;
      }) ?? null
    : data;
  const courseCount = visibleData?.reduce((total, studentData) => total + studentData.courses.length, 0) ?? 0;
  const homeworkCount = visibleData?.reduce((total, studentData) => total + studentData.homeworks.length, 0) ?? 0;
  const gradeCount = visibleData?.filter((studentData) => studentData.latestGrade).length ?? 0;

  const renderHolidaysCard = (currentOnly = false) => {
    const referenceDate = currentOnly ? new Date() : selectedDay;
    const { currentHoliday, nextHoliday, daysUntilNext } = getCurrentOrNextHoliday(schoolZone, referenceDate);
    const dateKey = [
      referenceDate.getFullYear(),
      String(referenceDate.getMonth() + 1).padStart(2, "0"),
      String(referenceDate.getDate()).padStart(2, "0")
    ].join("-");
    const holidayList = currentOnly
      ? currentHoliday ? [currentHoliday] : []
      : (SCHOOL_HOLIDAYS[schoolZone] || []).filter((holiday) => holiday.endDate > dateKey);
    return (
      <View style={styles.holidaysCard}>
        <View style={styles.holidaysHeader}>
          <View style={styles.rowContent}>
            <Text style={styles.holidaysTitle}>
              {currentHoliday ? "🏖️ Vacances scolaires (En cours)" : "📅 Vacances scolaires"}
            </Text>
            <Text style={styles.holidaysStatusText}>
              {currentHoliday
                ? `${currentHoliday.name} (reprise le ${shortDate(currentHoliday.endDate)})`
                : nextHoliday
                  ? `${nextHoliday.name} dans ${daysUntilNext} jour${(daysUntilNext ?? 0) > 1 ? "s" : ""} (du ${shortDate(nextHoliday.startDate)} au ${shortDate(nextHoliday.endDate)})`
                  : "Aucune vacances programmées"}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setHolidaysOpen(!holidaysOpen)}
            style={styles.holidaysToggleBtn}
          >
            <Text style={styles.holidaysToggleText}>{holidaysOpen ? "Masquer" : "Voir tout"}</Text>
            <ChevronDown size={16} color={palette.green} style={{ transform: [{ rotate: holidaysOpen ? "180deg" : "0deg" }] }} />
          </Pressable>
        </View>

        <View style={styles.zoneRow}>
          <Text style={styles.zoneLabel}>Zone :</Text>
          {(["A", "B", "C"] as SchoolZone[]).map((zone) => {
            const selected = schoolZone === zone;
            return (
              <Pressable
                key={zone}
                onPress={() => changeSchoolZone(zone)}
                style={[styles.zoneChip, selected && styles.zoneChipSelected]}
              >
                <Text style={[styles.zoneChipText, selected && styles.zoneChipTextSelected]}>Zone {zone}</Text>
              </Pressable>
            );
          })}
        </View>

        {holidaysOpen && (
          <View style={styles.holidaysList}>
            <Text style={styles.groupCaption}>Calendrier des vacances (Zone {schoolZone})</Text>
            {holidayList.map((holiday, idx) => {
              const isCurrent = currentHoliday?.name === holiday.name && currentHoliday?.startDate === holiday.startDate;
              return (
                <View key={`${holiday.name}-${idx}`} style={[styles.holidayRow, isCurrent && styles.holidayRowActive]}>
                  <View style={styles.rowContent}>
                    <Text style={[styles.rowTitle, isCurrent && styles.holidayActiveText]}>{holiday.name}</Text>
                    <Text style={styles.rowDetail}>
                      Du {shortDate(holiday.startDate)} au {shortDate(holiday.endDate)}
                    </Text>
                  </View>
                  {isCurrent && <Text style={styles.holidayBadge}>En cours</Text>}
                </View>
              );
            })}
          </View>
        )}
      </View>
    );
  };

  const renderProviderManager = () => (
    <View style={styles.parentSpace}>
      <View style={styles.parentSpaceHeading}>
        <Text style={styles.sectionTitle}>Espace parents & Services</Text>
        <Text style={styles.rowDetail}>Bascule entre les 3 onglets de services scolaires ci-dessous</Text>
      </View>

      <View style={styles.serviceTabRow}>
        {([
          ["ecoleDirecte", "École Directe"],
          ["skolengo", "Skolengo"],
          ["pronote", "Pronote"]
        ] as [ProviderType, string][]).map(([provider, label]) => {
          const selected = selectedProvider === provider;
          const account = providerAccounts.find((acc) => acc.provider === provider);
          const isConnected = account && providerSessionsRef.current.has(account.id);
          return (
            <Pressable
              key={provider}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setSelectedProvider(provider)}
              style={[styles.serviceTabButton, selected && styles.serviceTabButtonSelected]}
            >
              <View style={[styles.statusDot, isConnected ? styles.statusDotConnected : styles.statusDotDisconnected]} />
              <Text style={[styles.serviceTabText, selected && styles.serviceTabTextSelected]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      {providerAccounts.filter((account) => account.provider === selectedProvider).map((account) => {
        const serviceLabel = account.provider === "ecoleDirecte"
          ? "École Directe"
          : account.provider === "skolengo"
            ? `Skolengo${account.schoolName ? ` · ${account.schoolName}` : ""}`
            : "Pronote";
        return (
          <View key={account.id} style={styles.providerAccountRow}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>{account.parentName || account.label}</Text>
              <Text style={styles.rowDetail}>{serviceLabel}</Text>
              <Text style={styles.rowDetail}>
                {providerSessionsRef.current.has(account.id) ? "🟢 Connecté" : "🟠 À reconnecter"} · {account.students.length} enfant{account.students.length === 1 ? "" : "s"}
              </Text>
            </View>
            {!providerSessionsRef.current.has(account.id) && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reconnecter ${serviceLabel}`}
                onPress={() => void reconnectAccount(account)}
                disabled={busy}
                style={styles.providerReconnectButton}
              >
                <RefreshCw size={16} color={palette.green} />
                <Text style={styles.providerReconnectText}>Reconnecter</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Déconnecter ${serviceLabel}`}
              onPress={() => {
                if (Platform.OS === "web") {
                  if (window.confirm(`Déconnecter ${serviceLabel} ?`)) void removeProviderAccount(account);
                } else {
                  Alert.alert("Déconnecter ce service ?", serviceLabel, [
                    { text: "Annuler", style: "cancel" },
                    { text: "Déconnecter", style: "destructive", onPress: () => void removeProviderAccount(account) }
                  ]);
                }
              }}
              style={styles.providerDisconnectButton}
            >
              <LogOut size={16} color={palette.coral} />
            </Pressable>
          </View>
        );
      })}

      {selectedProvider === "ecoleDirecte" && !providerAccounts.some((acc) => acc.provider === "ecoleDirecte" && providerSessionsRef.current.has(acc.id)) && (
        <>
          <Text style={styles.inputLabel}>Identifiant École Directe</Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="username"
            placeholder="Identifiant École Directe"
            placeholderTextColor="#87938E"
            style={styles.input}
          />
          <Text style={styles.inputLabel}>Mot de passe</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            placeholder="Mot de passe"
            placeholderTextColor="#87938E"
            style={styles.input}
          />
          <AppButton
            label={busy ? "Connexion…" : "Connecter École Directe"}
            onPress={() => void connect()}
            icon={busy ? <ActivityIndicator color="#FFFFFF" /> : <ArrowRight size={17} color="#FFFFFF" />}
            disabled={busy}
          />
        </>
      )}

      {selectedProvider === "pronote" && !providerAccounts.some((acc) => acc.provider === "pronote" && providerSessionsRef.current.has(acc.id)) && (
        <>
          <AppButton
            label="Se connecter à Pronote via l’ENT"
            onPress={() => void connectPronoteAccount()}
            icon={<ArrowRight size={17} color="#FFFFFF" />}
            disabled={busy}
          />
        </>
      )}

      {selectedProvider === "skolengo" && !providerAccounts.some((acc) => acc.provider === "skolengo" && providerSessionsRef.current.has(acc.id)) && (
        <>
          <Text style={styles.inputLabel}>Établissement Skolengo</Text>
          <View style={styles.schoolSearchRow}>
            <TextInput
              value={schoolSearch}
              onChangeText={setSchoolSearch}
              placeholder="Nom de l’établissement"
              placeholderTextColor="#87938E"
              style={[styles.input, styles.schoolSearchInput]}
              onSubmitEditing={() => void findSkolengoSchools()}
              returnKeyType="search"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Rechercher un établissement Skolengo"
              onPress={() => void findSkolengoSchools()}
              disabled={busy}
              style={styles.schoolSearchButton}
            >
              {busy ? <ActivityIndicator color={palette.green} /> : <RefreshCw size={17} color={palette.green} />}
            </Pressable>
          </View>
          {skolengoSchools.map((school) => (
            <Pressable
              key={school.id}
              accessibilityRole="button"
              onPress={() => void connectSkolengoAccount(school)}
              disabled={busy}
              style={styles.schoolResult}
            >
              <View style={styles.rowContent}>
                <Text style={styles.rowTitle}>{school.name}</Text>
                <Text style={styles.rowDetail}>{school.location.city}</Text>
              </View>
              <ArrowRight size={16} color={palette.green} />
            </Pressable>
          ))}
        </>
      )}

      <View style={styles.rememberRow}>
        <Switch
          value={rememberCredentials}
          onValueChange={(enabled) => {
            setRememberCredentials(enabled);
            if (!enabled) {
              const metadataOnly = providerAccounts.map((account) => ({ ...account, refreshToken: undefined }));
              providerAccountsRef.current = metadataOnly;
              setProviderAccounts(metadataOnly);
              void persistProviderAccounts(metadataOnly, false);
              void SecureStore.deleteItemAsync(CREDENTIALS_KEY);
              void SecureStore.deleteItemAsync(DEVICE_KEY);
              void disableBackgroundSync();
              setBackgroundSyncEnabled(false);
            }
          }}
          trackColor={{ false: "#D4DBD7", true: "#76CBB0" }}
          thumbColor={rememberCredentials ? palette.green : "#FFFFFF"}
        />
        <Text style={styles.rememberText}>Mémoriser les connexions sur cet appareil</Text>
      </View>

      {childrenProfiles.length > 0 && (
        <View style={styles.parentChildrenSection}>
          <Text style={styles.inputLabel}>Enfants trouvés</Text>
          {childrenProfiles.map((child) => (
            <View key={child.id} style={styles.parentChildRow}>
              <PupilHeading
                pupil={{
                  id: childrenProfiles.indexOf(child) + 1,
                  prenom: child.firstName,
                  nom: child.lastName,
                  photo: childProfilePhoto(child, providerAccounts)
                }}
                detail={child.className}
                context="compte"
              />
              <ProviderSourceSelector
                child={child}
                accounts={providerAccounts.filter((account) => providerSessionsRef.current.has(account.id))}
                onChange={(domain, provider) => void changeDomainSource(child.id, domain, provider)}
              />
            </View>
          ))}
        </View>
      )}

      <Modal
        visible={pronoteLoginOpen}
        animationType="slide"
        onRequestClose={() => setPronoteLoginOpen(false)}
      >
        <SafeAreaView style={styles.pronoteLoginScreen} edges={["top", "bottom"]}>
          <View style={styles.pronoteLoginHeader}>
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>Connexion Pronote</Text>
              <Text style={styles.rowDetail}>Tu te connectes sur la page de ton ENT (EduConnect, FranceConnect…).</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Annuler la connexion Pronote"
              onPress={() => setPronoteLoginOpen(false)}
              style={styles.closeButton}
            >
              <X size={20} color={palette.ink} />
            </Pressable>
          </View>
          <View style={styles.pronotePinPanel}>
            <Text style={styles.inputLabel}>Adresse Pronote de l’établissement</Text>
            <TextInput
              value={pronoteStartUrl}
              onChangeText={setPronoteStartUrl}
              placeholder="https://0000000X.index-education.net/pronote"
              placeholderTextColor="#87938E"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            {!!pronoteLoginError && <Text accessibilityRole="alert" style={styles.pronoteLoginError}>{pronoteLoginError}</Text>}
            <AppButton
              label={busy ? "Connexion…" : "Ouvrir la connexion ENT"}
              onPress={startPronoteSso}
              icon={busy ? <ActivityIndicator color="#FFFFFF" /> : <ArrowRight size={17} color="#FFFFFF" />}
              disabled={busy || !pronoteStartUrl.trim()}
            />
          </View>
        </SafeAreaView>
        <PronoteSsoModal
          visible={pronoteSsoOpen}
          baseUrl={pronoteStartUrl}
          onCancel={() => setPronoteSsoOpen(false)}
          onCaptured={(capture) => void finishPronoteLogin(capture)}
          onError={(message) => {
            setPronoteSsoOpen(false);
            setPronoteLoginError(message);
          }}
        />
      </Modal>
    </View>
  );

  const rememberSectionOffset = (section: JournalSection) => (event: LayoutChangeEvent) => {
    journalSectionOffsets.current[section] = event.nativeEvent.layout.y;
  };

  const scrollToSection = (section: JournalSection) => {
    const offset = journalSectionOffsets.current[section];
    if (offset !== undefined) contentScrollRef.current?.scrollTo({ y: Math.max(0, offset - 8), animated: true });
  };

  // Stays above the scrolling content so children and sections remain reachable.
  const renderJournalBar = () => {
    const showSections = !getCurrentOrNextHoliday(schoolZone).currentHoliday;
    if (!childrenProfiles.length && !showSections) return null;
    return (
      <View style={styles.journalBar}>
        {childrenProfiles.length > 0 && (
          <ChildProfilesBar
            children={childrenProfiles}
            providerAccounts={providerAccounts}
            activeChildId={activeChildId}
            onSelectChild={selectActiveChild}
            onAddChild={() => setTab("compte")}
          />
        )}
        {showSections && (
          <View style={styles.sectionLinks}>
            {JOURNAL_SECTIONS.map(({ id, label, unit, Icon, color, tint }) => {
              const count = { courses: courseCount, homeworks: homeworkCount, grades: gradeCount }[id];
              return (
                <Pressable
                  key={id}
                  accessibilityRole="link"
                  accessibilityLabel={`Aller à la section ${label}`}
                  onPress={() => scrollToSection(id)}
                  style={[styles.sectionLink, styles[tint]]}
                >
                  <View style={styles.sectionLinkHeader}>
                    <Icon size={15} color={palette[color]} />
                    <Text style={styles.sectionLinkText} numberOfLines={1}>{label}</Text>
                  </View>
                  <View style={styles.sectionLinkCount}>
                    <Text style={styles.sectionLinkValue}>{data ? count : "—"}</Text>
                    <Text style={styles.summaryLabel} numberOfLines={1}>{unit}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    );
  };

  const renderJournal = () => {
    const currentHoliday = getCurrentOrNextHoliday(schoolZone).currentHoliday;
    return (
      <>
      {currentHoliday ? (
        renderHolidaysCard(true)
      ) : (
      <>
      <View style={styles.hero}>
        <View style={styles.heroTopline}>
          <Text style={styles.heroEyebrow}>TON JOUR EN UN COUP D'OEIL</Text>
          <CalendarDays color="#B9E9D9" size={19} />
        </View>
        <Text style={styles.heroDate}>{frenchDate(selectedDay)}</Text>
        <Text style={styles.heroCopy}>
          {data
            ? `${courseCount} cours ${isToday(selectedDay) ? "aujourd'hui" : `le ${frenchDate(selectedDay)}`} · ${homeworkCount} devoir${homeworkCount === 1 ? "" : "s"} à venir`
            : "Ton emploi du temps, tes devoirs et tes notes au même endroit."}
        </Text>
        {!data && (
          <Pressable style={styles.heroAction} onPress={() => setTab("compte")}>
            <Text style={styles.heroActionText}>Connecter École Directe</Text>
            <ArrowRight size={17} color="#173B35" />
          </Pressable>
        )}
      </View>

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{isToday(selectedDay) ? "Aujourd'hui" : frenchDate(selectedDay)}</Text>
        {data && (
          <Pressable accessibilityLabel="Synchroniser" onPress={() => void refresh()} style={styles.iconButton}>
            {busy ? <ActivityIndicator color={palette.green} /> : <RefreshCw size={18} color={palette.green} />}
          </Pressable>
        )}
      </View>

      <View style={styles.sectionHeading} onLayout={rememberSectionOffset("courses")}>
        <Text style={styles.sectionTitle}>Emploi du temps</Text>
        <View style={styles.dayNavigation}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jour précédent"
            disabled={busy}
            onPress={() => void navigateSchedule(-1)}
            style={[styles.dayNavigationButton, busy && styles.buttonDisabled]}
          >
            <ChevronLeft size={18} color={palette.ink} />
          </Pressable>
          <Text style={styles.sectionMeta}>{new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(selectedDay)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Jour suivant"
            disabled={busy}
            onPress={() => void navigateSchedule(1)}
            style={[styles.dayNavigationButton, busy && styles.buttonDisabled]}
          >
            <ChevronRight size={18} color={palette.ink} />
          </Pressable>
        </View>
      </View>
      <View style={styles.listSection}>
        {!data && <EmptyLine>Connecte ton compte pour afficher les cours de la journée.</EmptyLine>}
        {data && visibleData?.length === 0 && <EmptyLine>Aucune donnée ne correspond à ce profil enfant.</EmptyLine>}
        {visibleData?.map((studentData) => (
          <View key={studentData.student.id} style={styles.pupilGroup}>
            <PupilHeading pupil={studentData.student} detail={`${studentData.courses.length} cours`} />
            {studentData.error ? <EmptyLine>{studentData.error}</EmptyLine> : studentData.courses.length === 0 ? <EmptyLine>Aucun cours prévu ce jour-là.</EmptyLine> :
              studentData.courses.map((course, index) => (
                <View key={`${course.subject}-${course.start}-${index}`} style={styles.listRow}>
                  <Text style={styles.rowTime}>{courseTime(course.start)}</Text>
                  <View style={styles.rowRule} />
                  <View style={styles.rowContent}>
                    <Text style={styles.rowTitle}>{course.subject}</Text>
                    <Text style={styles.rowDetail}>
                      {[course.room, course.teacher].filter(Boolean).join(" · ") || "Détail non renseigné"}
                    </Text>
                  </View>
                </View>
              ))}
          </View>
        ))}
      </View>

      <View style={styles.sectionHeading} onLayout={rememberSectionOffset("homeworks")}>
        <Text style={styles.sectionTitle}>À préparer</Text>
        <Text style={styles.sectionMeta}>{preferences.homeworkDays} jours</Text>
      </View>
      <View style={styles.listSection}>
        {!data && <EmptyLine>Les devoirs à venir apparaîtront ici après connexion.</EmptyLine>}
        {visibleData?.map((studentData) => (
          <View key={studentData.student.id} style={styles.pupilGroup}>
            <PupilHeading pupil={studentData.student} detail={`${studentData.homeworks.length} devoir${studentData.homeworks.length === 1 ? "" : "s"}`} />
            {studentData.error ? <EmptyLine>{studentData.error}</EmptyLine> : studentData.homeworks.length === 0 ? <EmptyLine>Aucun devoir sur cette période.</EmptyLine> :
              studentData.homeworks.map((homework, index) => (
                <Pressable
                  key={`${homework.subject}-${homework.dueDate}-${index}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Ouvrir le devoir de ${homework.subject}`}
                  onPress={() => setSelectedHomework({ student: studentData.student, homework })}
                  style={styles.homeworkRow}
                >
                  <View
                    accessibilityRole="image"
                    accessibilityLabel={homework.done ? "Devoir fait" : "Devoir à faire"}
                    style={[styles.homeworkMark, homework.done ? styles.homeworkDoneMark : styles.homeworkTodoMark]}
                  />
                  <View style={styles.rowContent}>
                    <Text style={styles.rowTitle}>{homework.subject}</Text>
                    <Text style={styles.rowDetail} numberOfLines={2}>{homework.preview || "Ouvrir le devoir"}</Text>
                  </View>
                  <Text style={[styles.homeworkStatus, homework.done ? styles.homeworkDoneText : styles.homeworkTodoText]}>
                    {homework.done ? "Fait" : "À faire"}
                  </Text>
                  <Text style={styles.dueDate}>{shortDate(homework.dueDate)}</Text>
                </Pressable>
              ))}
          </View>
        ))}
      </View>

      <View style={styles.sectionHeading} onLayout={rememberSectionOffset("grades")}>
        <Text style={styles.sectionTitle}>Dernières notes</Text>
      </View>
      <View style={styles.listSection}>
        {!data && <EmptyLine>Connecte ton compte pour retrouver tes notes.</EmptyLine>}
        {visibleData?.map((studentData) => (
          <View key={studentData.student.id} style={styles.pupilGroup}>
            <PupilHeading pupil={studentData.student} />
            {studentData.error ? <EmptyLine>{studentData.error}</EmptyLine> : (
              <>
                {studentData.gradesError && <EmptyLine>{studentData.gradesError}</EmptyLine>}
                <Text style={styles.groupCaption}>Matières et dernières notes</Text>
                {studentData.grades.length === 0 ? <EmptyLine>Aucune note récente.</EmptyLine> :
                  studentData.grades.map((grade, index) => (
                    <View key={`${grade.subject}-${grade.date}-${index}`} style={styles.gradeRow}>
                      <View style={styles.rowContent}>
                        <Text style={[styles.rowTitle, isNewGrade(grade.date) && styles.newGradeTitle]}>{grade.subject}</Text>
                        <Text style={styles.rowDetail}>{shortDate(grade.date)}</Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={[styles.gradeValue, isNewGrade(grade.date) && styles.newGradeTitle]}>{grade.value}</Text>
                        {!!grade.classAverage && (
                          <Text style={styles.classAverageText}>{grade.classAverage}</Text>
                        )}
                      </View>
                    </View>
                  ))}
                {studentData.competencies.length > 0 && (
                  <>
                    <Text style={styles.groupCaption}>Compétences</Text>
                    {studentData.competencies.map((competence, index) => (
                      <View key={`${competence.subject}-${competence.label}-${index}`} style={styles.competenceRow}>
                        <View style={styles.rowContent}>
                          <Text style={styles.rowTitle}>{competence.subject}</Text>
                          <Text style={styles.rowDetail}>{competence.label}</Text>
                        </View>
                        {!!competence.value && <Text style={styles.gradeValue}>{competence.value}</Text>}
                      </View>
                    ))}
                  </>
                )}
              </>
            )}
          </View>
        ))}
      </View>
      </>
      )}
    </>
    );
  };

  const renderReminders = () => (
    <>
      <View style={styles.pageIntro}>
        <Text style={styles.pageTitle}>Tes rappels</Text>
        <Text style={styles.pageDescription}>Choisis quand Tempo te prévient chaque jour.</Text>
      </View>
      <ReminderRow
        title="Cours de la journée"
        detail="Ton emploi du temps du jour"
        time={preferences.classes.time}
        enabled={preferences.classes.enabled}
        color={palette.green}
        onTime={(time) => updateReminder("classes", { time })}
        onEnabled={(enabled) => updateReminder("classes", { enabled })}
      />
      <ReminderRow
        title="Devoirs à venir"
        detail="Les échéances de ta période"
        time={preferences.homework.time}
        enabled={preferences.homework.enabled}
        color={palette.coral}
        onTime={(time) => updateReminder("homework", { time })}
        onEnabled={(enabled) => updateReminder("homework", { enabled })}
      />
      <ReminderRow
        title="Dernières notes"
        detail="Quand une note est disponible"
        time={preferences.grades.time}
        enabled={preferences.grades.enabled}
        color={palette.blue}
        onTime={(time) => updateReminder("grades", { time })}
        onEnabled={(enabled) => updateReminder("grades", { enabled })}
      />
      <PauseCard
        freeze={preferences.freeze}
        onChange={(freeze) => setPreferences((current) => ({ ...current, freeze }))}
      />
      <View style={styles.reminderNote}>
        <Bell size={17} color={palette.green} />
        <Text style={styles.reminderNoteText}>
          Le contenu des rappels reflète la dernière synchronisation. Ouvre Journal et actualise pour le mettre à jour.
        </Text>
      </View>
      <AppButton
        label={busy ? "Envoi…" : "Tester les notifications"}
        onPress={() => void testNotifications()}
        icon={busy ? <ActivityIndicator color="#FFFFFF" /> : <Bell size={17} color="#FFFFFF" />}
        disabled={busy}
      />
      <View style={{ height: 10 }} />
      <AppButton label="Enregistrer les horaires" onPress={() => void savePreferences()} icon={<Check size={17} color="#FFFFFF" />} />
    </>
  );

  const renderMessages = () => {
    const visibleChildren = activeChildId
      ? childrenProfiles.filter((child) => child.id === activeChildId)
      : childrenProfiles;
    const mailboxSize = new Map<string, number>();
    for (const entry of messagesByChild || []) {
      const child = childrenProfiles.find((item) => item.id === entry.childId);
      const accountId = entry.provider ? child?.links[entry.provider]?.accountId : undefined;
      if (accountId) mailboxSize.set(accountId, (mailboxSize.get(accountId) || 0) + 1);
    }
    return (
      <>
        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Messages reçus</Text>
          <View style={styles.dayNavigation}>
            <Text style={styles.sectionMeta}>{preferences.messageCount} dernier{preferences.messageCount === 1 ? "" : "s"}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Actualiser la messagerie"
              onPress={() => void loadMessages()}
              disabled={messagesBusy}
              style={styles.iconButton}
            >
              {messagesBusy ? <ActivityIndicator color={palette.green} /> : <RefreshCw size={16} color={palette.green} />}
            </Pressable>
          </View>
        </View>
        <View style={styles.listSection}>
          {!childrenProfiles.length && <EmptyLine>Connecte un compte pour retrouver la messagerie.</EmptyLine>}
          {visibleChildren.map((child, index) => {
            const entry = messagesByChild?.find((item) => item.childId === child.id);
            const provider = child.sources.messages ?? null;
            const accountId = provider ? child.links[provider]?.accountId : undefined;
            const shared = !!accountId && (mailboxSize.get(accountId) || 0) > 1;
            const pupil: EdPupil = {
              id: index + 1,
              prenom: child.firstName,
              nom: child.lastName,
              photo: childProfilePhoto(child, providerAccounts),
              classe: { libelle: child.className }
            };
            const detail = provider
              ? `${PROVIDER_LABELS[provider]}${shared ? " · boîte partagée" : ""}`
              : "Messagerie désactivée";
            return (
              <View key={child.id} style={styles.pupilGroup}>
                <PupilHeading pupil={pupil} detail={detail} />
                {!provider ? <EmptyLine>Choisis une source « Messagerie » pour cet enfant dans Compte.</EmptyLine>
                  : !entry ? <EmptyLine>{messagesBusy ? "Chargement des messages…" : "Actualise pour charger les messages."}</EmptyLine>
                  : entry.error ? <EmptyLine>{`${PROVIDER_LABELS[provider]} : ${entry.error}`}</EmptyLine>
                  : entry.messages.length === 0 ? <EmptyLine>Aucun message reçu.</EmptyLine>
                  : entry.messages.map((message) => {
                    const key = `${child.id}:${message.id}`;
                    const expanded = expandedMessage === key;
                    return (
                      <Pressable
                        key={key}
                        accessibilityRole="button"
                        accessibilityState={{ expanded }}
                        accessibilityLabel={`${message.read ? "" : "Non lu, "}${message.subject}, de ${message.from}`}
                        onPress={() => setExpandedMessage(expanded ? null : key)}
                        style={styles.homeworkRow}
                      >
                        <View style={[styles.homeworkMark, message.read ? styles.messageReadMark : styles.homeworkTodoMark]} />
                        <View style={styles.rowContent}>
                          <Text style={[styles.rowTitle, !message.read && styles.newGradeTitle]} numberOfLines={expanded ? undefined : 1}>{message.subject}</Text>
                          <Text style={styles.messageSender} numberOfLines={1}>{message.from}</Text>
                          {!!message.preview && (
                            <Text style={styles.rowDetail} numberOfLines={expanded ? undefined : 2}>{message.preview}</Text>
                          )}
                        </View>
                        <Text style={styles.dueDate}>{message.date ? shortDate(message.date) : ""}</Text>
                      </Pressable>
                    );
                  })}
              </View>
            );
          })}
        </View>
        {messagesSyncedAt && (
          <Text style={styles.syncCaption}>
            Messagerie relevée à {new Date(messagesSyncedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </Text>
        )}
      </>
    );
  };

  const renderAccount = () => (
    <>
      <View style={styles.pageIntro}>
        <Text style={styles.pageTitle}>Comptes parents</Text>
        <Text style={styles.pageDescription}>Relie les services scolaires utilisés par ta famille.</Text>
      </View>
      {providerAccounts.length > 0 && (
        <View style={styles.settingsMenu}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: accountSettingsOpen }}
            onPress={() => {
              const willOpen = !accountSettingsOpen;
              setAccountSettingsOpen(willOpen);
              if (willOpen) void checkBackgroundConfiguration();
            }}
            style={styles.settingsMenuHeader}
          >
            <Settings2 size={18} color={palette.green} />
            <Text style={styles.settingsMenuTitle}>Paramètres</Text>
            <ChevronDown size={18} color={palette.muted} />
          </Pressable>
          {accountSettingsOpen && (
            <View style={styles.settingsPanel}>
              <Text style={styles.settingsGroupTitle}>Affichage</Text>
              <SettingStepper
                title="Période des devoirs"
                detail="Nombre de jours de devoirs affichés dans le journal"
                value={preferences.homeworkDays}
                min={1}
                max={14}
                unit="jours"
                onChange={(value) => void updateDisplaySetting("homeworkDays", value)}
              />
              <SettingStepper
                title="Messages affichés"
                detail="Nombre de derniers messages reçus par enfant"
                value={preferences.messageCount}
                min={1}
                max={20}
                unit="messages"
                onChange={(value) => void updateDisplaySetting("messageCount", value)}
              />
              <Text style={styles.settingsGroupTitle}>Synchronisation</Text>
              <View style={styles.settingsToggleRow}>
                <View style={styles.rowContent}>
                  <Text style={styles.rowTitle}>Synchronisation périodique</Text>
                  <Text style={styles.rowDetail}>Android tente une synchronisation environ toutes les heures.</Text>
                </View>
                <Switch
                  value={backgroundSyncEnabled}
                  onValueChange={(enabled) => void updateBackgroundSync(enabled)}
                  disabled={busy || Platform.OS !== "android" || (!rememberCredentials && !backgroundSyncEnabled)}
                  trackColor={{ false: "#D4DBD7", true: "#76CBB0" }}
                  thumbColor={backgroundSyncEnabled ? palette.green : "#FFFFFF"}
                />
              </View>
              {!rememberCredentials && !backgroundSyncEnabled && (
                <Text style={styles.settingsHint}>Coche « Garder les identifiants sur cet appareil » à la connexion pour l’activer.</Text>
              )}
              <Text style={styles.settingsExplanation}>
                WorkManager attend le réseau et reprend après redémarrage. Android peut différer la tâche; aucune alarme exacte ni permission batterie spéciale n’est demandée.
              </Text>
              <Text style={styles.settingsStatusText}>Réseau et redémarrage : gérés par WorkManager, sans demande runtime.</Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => void checkBackgroundConfiguration()}
                disabled={busy}
                style={styles.settingsCheckButton}
              >
                {busy ? <ActivityIndicator color={palette.green} /> : <RefreshCw size={16} color={palette.green} />}
                <Text style={styles.settingsCheckText}>Vérifier la configuration</Text>
              </Pressable>
              {backgroundSyncStatus && (
                <View style={styles.settingsStatus}>
                  <Text style={styles.settingsStatusText}>Service arrière-plan : {backgroundSyncStatus.available ? "disponible" : "indisponible"}</Text>
                  <Text style={styles.settingsStatusText}>Worker horaire : {backgroundSyncStatus.registered ? "enregistré" : "non enregistré"}</Text>
                  <Text style={styles.settingsStatusText}>Identifiants sécurisés : {backgroundSyncStatus.credentialsSaved ? "présents" : "absents"}</Text>
                  <Text style={styles.settingsStatusText}>Notifications Android : {backgroundSyncStatus.notificationsGranted ? "autorisées" : "non autorisées (facultatives)"}</Text>
                  <Text style={styles.settingsStatusText}>
                    Dernière exécution : {backgroundSyncStatus.lastSyncAt
                      ? `${backgroundSyncStatus.lastSyncSucceeded ? "réussie" : "incomplète"}, ${new Date(backgroundSyncStatus.lastSyncAt).toLocaleString("fr-FR")}`
                      : "aucune"}
                  </Text>
                  <Text style={styles.settingsStatusText}>
                    Notifications émises après synchro : {backgroundSyncStatus.lastNotificationsSent ?? "—"}
                  </Text>
                  {!!backgroundSyncStatus.lastError && <Text style={styles.settingsStatusText}>{backgroundSyncStatus.lastError}</Text>}
                </View>
              )}
            </View>
          )}
        </View>
      )}
      {challenge && (
        <View style={styles.loginPanel}>
          <Text style={styles.formTitle}>Vérification requise</Text>
          <Text style={styles.formDescription}>{challenge.question}</Text>
          <View style={styles.challengeOptions}>
            {challenge.options.map((option) => (
              <Pressable key={option.value} onPress={() => void answerChallenge(option.value)} style={styles.challengeOption}>
                <Text style={styles.challengeOptionText}>{option.label}</Text>
                <ArrowRight size={16} color={palette.green} />
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => setChallenge(null)}><Text style={styles.cancelText}>Annuler</Text></Pressable>
        </View>
      )}
      {renderProviderManager()}
      {renderHolidaysCard()}
      <View style={styles.privacyNote}>
        <Text style={styles.privacyTitle}>Tes données restent sur ton téléphone</Text>
        <Text style={styles.privacyCopy}>
          Les connexions utilisent les API non officielles des services scolaires. Identifiants et jetons restent sur ce téléphone; leur mémorisation est facultative et protégée.
        </Text>
      </View>
    </>
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.appContent}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.brandMark}><CalendarDays size={19} color="#FFFFFF" /></View>
        <View style={styles.brandTextWrap}>
          <Text style={styles.brand}>tempo</Text>
          <Text style={styles.brandCaption}>SERVICES SCOLAIRES, EN CLAIR</Text>
        </View>
        <View style={[styles.connectionDot, data ? styles.connectionOnline : styles.connectionOffline]} />
        <Text style={styles.connectionLabel}>{data ? "Connecté" : "Hors ligne"}</Text>
      </View>

      {tab === "journal" && renderJournalBar()}
      {tab === "messages" && childrenProfiles.length > 0 && (
        <View style={styles.journalBar}>
          <ChildProfilesBar
            children={childrenProfiles}
            providerAccounts={providerAccounts}
            activeChildId={activeChildId}
            onSelectChild={selectActiveChild}
            onAddChild={() => setTab("compte")}
          />
        </View>
      )}
      <ScrollView
        ref={contentScrollRef}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <DevTools />
        {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
        {tab === "journal" && renderJournal()}
        {tab === "messages" && renderMessages()}
        {tab === "rappels" && renderReminders()}
        {tab === "compte" && renderAccount()}
        {tab !== "messages" && data?.length ? <Text style={styles.syncCaption}>Dernière synchro {new Date(data[0].syncedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</Text> : null}
      </ScrollView>

      <Modal
        visible={selectedHomework !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedHomework(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.homeworkModal}>
            <View style={styles.homeworkModalHeader}>
              <View style={styles.rowContent}>
                <Text style={styles.homeworkModalTitle}>{selectedHomework?.homework.subject}</Text>
                <Text style={styles.rowDetail}>
                  {selectedHomework && [selectedHomework.student.prenom, selectedHomework.student.nom].filter(Boolean).join(" ")} · {selectedHomework && shortDate(selectedHomework.homework.dueDate)}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Fermer le devoir"
                onPress={() => setSelectedHomework(null)}
                style={styles.closeButton}
              >
                <X size={20} color={palette.ink} />
              </Pressable>
            </View>
            {selectedHomework && (
              <WebView
                originWhitelist={["*"]}
                javaScriptEnabled={false}
                source={{ html: homeworkDocument(selectedHomework.homework.content) }}
                style={styles.homeworkWebView}
              />
            )}
          </View>
        </View>
      </Modal>

      <View style={styles.tabBar}>
        {tabItems.map(({ id, label, Icon }) => {
          const selected = tab === id;
          return (
            <Pressable key={id} onPress={() => setTab(id)} style={styles.tabItem} accessibilityRole="tab" accessibilityState={{ selected }}>
              <Icon size={19} color={selected ? palette.green : palette.muted} />
              <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>{label}</Text>
              {selected && <View style={styles.tabIndicator} />}
            </Pressable>
          );
        })}
      </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function isoToFrench(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function frenchToIso(text: string): string {
  const match = text.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  const valid = date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day);
  return valid ? `${year}-${month}-${day}` : "";
}

function PauseDateInput({ label, iso, onChange }: { label: string; iso: string; onChange: (iso: string) => void }) {
  const [text, setText] = useState(isoToFrench(iso));
  useEffect(() => {
    if (iso) setText(isoToFrench(iso));
  }, [iso]);
  const invalid = text.length === 10 && !frenchToIso(text);
  return (
    <View style={styles.pauseDateField}>
      <Text style={styles.rowDetail}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={text}
        onChangeText={(value) => {
          setText(value);
          onChange(frenchToIso(value));
        }}
        placeholder="JJ/MM/AAAA"
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        style={[styles.pauseDateInput, invalid && styles.pauseDateInvalid]}
      />
    </View>
  );
}

function PauseCard({
  freeze,
  onChange
}: {
  freeze: ReminderPreferences["freeze"];
  onChange: (freeze: NonNullable<ReminderPreferences["freeze"]>) => void;
}) {
  const current = freeze ?? { enabled: false, startDate: "", endDate: "" };
  const incomplete = current.enabled && (!current.startDate || !current.endDate || current.endDate < current.startDate);
  return (
    <View style={styles.pauseCard}>
      <View style={styles.settingsToggleRow}>
        <View style={styles.rowContent}>
          <Text style={styles.rowTitle}>Mettre en pause</Text>
          <Text style={styles.rowDetail}>Aucune notification entre deux dates (incluses).</Text>
        </View>
        <Switch
          value={current.enabled}
          onValueChange={(enabled) => onChange({ ...current, enabled })}
          trackColor={{ false: "#D4DBD7", true: "#76CBB0" }}
          thumbColor={current.enabled ? palette.green : "#FFFFFF"}
        />
      </View>
      {current.enabled && (
        <>
          <View style={styles.pauseDates}>
            <PauseDateInput label="Du" iso={current.startDate} onChange={(startDate) => onChange({ ...current, startDate })} />
            <PauseDateInput label="Au" iso={current.endDate} onChange={(endDate) => onChange({ ...current, endDate })} />
          </View>
          {incomplete && (
            <Text style={styles.settingsHint}>Saisis deux dates valides, la fin après le début. Sinon la pause est ignorée.</Text>
          )}
        </>
      )}
    </View>
  );
}

function ReminderRow({
  title,
  detail,
  time,
  enabled,
  color,
  onTime,
  onEnabled
}: {
  title: string;
  detail: string;
  time: string;
  enabled: boolean;
  color: string;
  onTime: (value: string) => void;
  onEnabled: (value: boolean) => void;
}) {
  return (
    <View style={styles.reminderRow}>
      <View style={[styles.reminderAccent, { backgroundColor: color }]} />
      <View style={styles.rowContent}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <TextInput
        accessibilityLabel={`Horaire : ${title}`}
        value={time}
        onChangeText={onTime}
        keyboardType="numbers-and-punctuation"
        maxLength={5}
        style={styles.timeInput}
      />
      <Switch
        value={enabled}
        onValueChange={onEnabled}
        trackColor={{ false: "#D4DBD7", true: "#76CBB0" }}
        thumbColor={enabled ? palette.green : "#FFFFFF"}
      />
    </View>
  );
}

const palette = {
  ink: "#1D3330",
  muted: "#73817B",
  green: "#16866A",
  coral: "#DB7256",
  blue: "#4A779B",
  line: "#E4EAE6",
  surface: "#FFFFFF",
  background: "#F4F7F4"
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.background },
  appContent: { flex: 1 },
  header: { minHeight: 74, paddingHorizontal: 21, paddingTop: Platform.OS === "android" ? 16 : 8, flexDirection: "row", alignItems: "center", backgroundColor: palette.background },
  brandMark: { width: 37, height: 37, borderRadius: 12, backgroundColor: palette.green, alignItems: "center", justifyContent: "center" },
  brandTextWrap: { marginLeft: 10, flex: 1 },
  brand: { color: palette.ink, fontSize: 20, fontWeight: "800", lineHeight: 22 },
  brandCaption: { color: palette.muted, fontSize: 9, fontWeight: "700", marginTop: 2 },
  connectionDot: { width: 8, height: 8, borderRadius: 4, marginRight: 7 },
  connectionOnline: { backgroundColor: palette.green },
  connectionOffline: { backgroundColor: "#D69A43" },
  connectionLabel: { color: palette.muted, fontSize: 11, fontWeight: "600" },
  content: { paddingHorizontal: 20, paddingBottom: 28, flexGrow: 1 },
  hero: { backgroundColor: "#173B35", borderRadius: 20, padding: 20, marginTop: 8, overflow: "hidden" },
  heroTopline: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroEyebrow: { color: "#B9E9D9", fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  heroDate: { color: "#FFFFFF", fontSize: 24, fontWeight: "700", marginTop: 17, textTransform: "capitalize" },
  heroCopy: { color: "#D0E1DA", fontSize: 13, lineHeight: 19, marginTop: 7, maxWidth: 290 },
  heroAction: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#B9E9D9", borderRadius: 9, paddingHorizontal: 12, paddingVertical: 10, marginTop: 18 },
  heroActionText: { color: "#173B35", fontSize: 12, fontWeight: "700" },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 24, marginBottom: 10 },
  sectionTitle: { color: palette.ink, fontSize: 17, fontWeight: "700" },
  sectionMeta: { color: palette.muted, fontSize: 11, fontWeight: "600" },
  dayNavigation: { flexDirection: "row", alignItems: "center", gap: 8 },
  dayNavigationButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: "#E7F2ED" },
  iconButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#E7F2ED" },
  summaryMint: { backgroundColor: "#E2F1EA" },
  summaryPeach: { backgroundColor: "#F8E8E0" },
  summaryBlue: { backgroundColor: "#E5EDF3" },
  summaryLabel: { color: palette.muted, fontSize: 10, fontWeight: "600" },
  listSection: { backgroundColor: palette.surface, borderRadius: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: palette.line },
  listRow: { minHeight: 66, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: palette.line },
  rowTime: { color: palette.green, width: 48, fontSize: 12, fontWeight: "700" },
  rowRule: { width: 2, height: 34, backgroundColor: "#B9E9D9", marginRight: 12, borderRadius: 1 },
  rowContent: { flex: 1, minWidth: 0 },
  rowTitle: { color: palette.ink, fontSize: 13, fontWeight: "700" },
  rowDetail: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  emptyLine: { color: palette.muted, fontSize: 12, lineHeight: 18, paddingVertical: 16 },
  homeworkRow: { minHeight: 67, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderBottomColor: palette.line, paddingVertical: 11 },
  homeworkMark: { width: 9, height: 9, borderRadius: 5 },
  homeworkDoneMark: { backgroundColor: palette.green },
  homeworkTodoMark: { backgroundColor: palette.coral },
  homeworkStatus: { fontSize: 10, fontWeight: "600" },
  homeworkDoneText: { color: palette.green },
  homeworkTodoText: { color: palette.coral },
  newGradeTitle: { fontWeight: "900" },
  dueDate: { color: palette.coral, fontSize: 10, fontWeight: "700", marginLeft: 5 },
  gradeStrip: { flexDirection: "row", gap: 12, alignItems: "center", padding: 15, marginTop: 17, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
  gradeValue: { color: palette.blue, fontSize: 15, fontWeight: "800", marginLeft: 6 },
  groupCaption: { color: palette.muted, fontSize: 10, fontWeight: "700", paddingHorizontal: 12, paddingTop: 9, textTransform: "uppercase" },
  gradeRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderBottomColor: palette.line, paddingHorizontal: 12, paddingVertical: 8 },
  competenceRow: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderBottomColor: palette.line, paddingHorizontal: 12, paddingVertical: 8 },
  pageIntro: { marginTop: 18, marginBottom: 18 },
  pageTitle: { color: palette.ink, fontSize: 27, fontWeight: "800" },
  pageDescription: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  reminderRow: { minHeight: 84, flexDirection: "row", alignItems: "center", gap: 9, borderBottomWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF", paddingHorizontal: 12, marginBottom: 1 },
  reminderAccent: { width: 4, height: 39, borderRadius: 2, marginRight: 2 },
  timeInput: { minWidth: 57, color: palette.ink, fontSize: 14, fontWeight: "700", textAlign: "center", backgroundColor: palette.background, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 8 },
  pauseCard: { backgroundColor: "#FFFFFF", borderRadius: 12, borderWidth: 1, borderColor: palette.line, paddingHorizontal: 14, paddingVertical: 8, marginTop: 17 },
  pauseDates: { flexDirection: "row", gap: 12, paddingBottom: 10 },
  pauseDateField: { flex: 1 },
  pauseDateInput: { color: palette.ink, fontSize: 14, fontWeight: "700", backgroundColor: palette.background, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginTop: 4 },
  pauseDateInvalid: { borderWidth: 1, borderColor: palette.coral },
  stepper: { flexDirection: "row", alignItems: "center", gap: 11 },
  stepButton: { width: 30, height: 30, borderRadius: 9, backgroundColor: palette.background, alignItems: "center", justifyContent: "center" },
  stepValue: { color: palette.ink, fontSize: 14, fontWeight: "800", minWidth: 15, textAlign: "center" },
  reminderNote: { flexDirection: "row", gap: 10, alignItems: "flex-start", padding: 14, marginTop: 17, marginBottom: 18, borderRadius: 12, backgroundColor: "#E6F1EC" },
  reminderNoteText: { flex: 1, color: "#42665A", fontSize: 11, lineHeight: 17 },
  button: { minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, paddingHorizontal: 16, borderRadius: 11, backgroundColor: palette.green },
  buttonSecondary: { backgroundColor: "#E7F2ED" },
  buttonDisabled: { opacity: 0.6 },
  buttonPressed: { opacity: 0.82 },
  buttonText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  buttonTextSecondary: { color: palette.green },
  settingsMenu: { marginTop: 12, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
  settingsMenuHeader: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 },
  settingsMenuTitle: { flex: 1, color: palette.ink, fontSize: 13, fontWeight: "700" },
  settingsGroupTitle: { color: palette.muted, fontSize: 10, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase", marginTop: 14 },
  messageReadMark: { backgroundColor: palette.line },
  messageSender: { color: palette.ink, fontSize: 11, marginTop: 2 },
  settingsPanel: { paddingHorizontal: 14, paddingBottom: 14, borderTopWidth: 1, borderTopColor: palette.line },
  settingsToggleRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 10 },
  settingsHint: { color: palette.coral, fontSize: 11, lineHeight: 16, marginBottom: 8 },
  settingsExplanation: { color: palette.muted, fontSize: 10, lineHeight: 15, paddingVertical: 8 },
  settingsCheckButton: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: "#E7F2ED" },
  settingsCheckText: { color: palette.green, fontSize: 11, fontWeight: "700" },
  settingsStatus: { gap: 5, paddingTop: 11 },
  settingsStatusText: { color: palette.muted, fontSize: 10, lineHeight: 15 },
  pupilGroup: { paddingTop: 10, paddingBottom: 5, borderBottomWidth: 1, borderBottomColor: palette.line },
  pupilHeading: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 12, paddingVertical: 5 },
  pupilPhoto: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#E2F1EA" },
  pupilPhotoFallback: { alignItems: "center", justifyContent: "center" },
  modalBackdrop: { flex: 1, justifyContent: "center", padding: 16, backgroundColor: "rgba(15, 29, 25, 0.58)" },
  homeworkModal: { height: "90%", overflow: "hidden", borderRadius: 14, backgroundColor: "#FFFFFF" },
  homeworkModalHeader: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: palette.line },
  homeworkModalTitle: { color: palette.ink, fontSize: 16, fontWeight: "700" },
  closeButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", backgroundColor: palette.background },
  homeworkWebView: { flex: 1, backgroundColor: "#FFFFFF" },
  loginPanel: { padding: 17, borderRadius: 16, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
  childBarContainer: { marginTop: 8, marginBottom: 8 },
  journalBar: { paddingHorizontal: 20, paddingBottom: 8, backgroundColor: palette.background, borderBottomWidth: 1, borderBottomColor: palette.line },
  sectionLinks: { flexDirection: "row", gap: 6 },
  sectionLink: { flex: 1, minWidth: 0, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  sectionLinkHeader: { flexDirection: "row", alignItems: "center", gap: 5 },
  sectionLinkText: { flexShrink: 1, color: palette.ink, fontSize: 12, fontWeight: "700" },
  sectionLinkCount: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  sectionLinkValue: { color: palette.ink, fontSize: 18, fontWeight: "700" },
  childBarScroll: { flexDirection: "row", gap: 8, paddingHorizontal: 2 },
  childChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
  childChipActive: { backgroundColor: palette.green, borderColor: palette.green },
  // The photo fills the whole chip circle; the 2px border marks the selection.
  childChipWithPhoto: { padding: 0, minWidth: 36, height: 36, borderRadius: 18, borderWidth: 2, overflow: "hidden", justifyContent: "center" },
  childChipPhoto: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#E2F1EA" },
  childChipText: { fontSize: 12, fontWeight: "700", color: palette.ink },
  childChipTextActive: { color: "#FFFFFF" },
  childChipAdd: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: palette.line, backgroundColor: "#E7F2ED" },
  childChipAddText: { fontSize: 12, fontWeight: "700", color: palette.green },
  childSourcesCard: { gap: 12, padding: 12, marginTop: 10, borderRadius: 10, backgroundColor: palette.background },
  childSourceRow: { gap: 7 },
  childSourceLabel: { color: palette.ink, fontSize: 11, fontWeight: "700" },
  domainChoiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  domainChoice: { minHeight: 34, justifyContent: "center", paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface },
  domainChoiceSelected: { borderColor: palette.green, backgroundColor: "#E2F1EA" },
  domainChoiceText: { color: palette.muted, fontSize: 10, fontWeight: "600" },
  domainChoiceTextSelected: { color: palette.green, fontWeight: "800" },
  parentSpace: { marginTop: 20, padding: 15, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface },
  classAverageText: { color: palette.muted, fontSize: 10, fontWeight: "600", marginTop: 2 },
  initialsText: { color: palette.green, fontSize: 15, fontWeight: "800" },
  subTabBar: { flexDirection: "row", gap: 6, marginBottom: 16, backgroundColor: "#E7F2ED", padding: 4, borderRadius: 12 },
  subTabButton: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 9 },
  subTabButtonActive: { backgroundColor: palette.green },
  subTabText: { fontSize: 11, fontWeight: "700", color: palette.green },
  subTabTextActive: { color: "#FFFFFF" },
  maintenanceCard: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF", marginBottom: 14 },
  parentSpaceHeading: { gap: 3, marginBottom: 13 },
  pronoteLoginScreen: { flex: 1, backgroundColor: palette.background },
  pronoteLoginHeader: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: palette.line },
  pronotePinPanel: { flex: 1, justifyContent: "center", gap: 10, padding: 20, backgroundColor: palette.surface },
  pronoteLoginError: { color: palette.coral, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  providerAccountRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: palette.line },
  providerDisconnectButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: "#F8E8E0" },
  providerReconnectButton: { height: 38, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 9, backgroundColor: "#E4F3EC", marginRight: 8 },
  providerReconnectText: { color: palette.green, fontSize: 13, fontWeight: "800" },
  serviceProviderRow: { flexDirection: "row", gap: 6, marginBottom: 14 },
  serviceProviderButton: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", paddingHorizontal: 5, borderRadius: 8, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.background },
  serviceProviderButtonSelected: { borderColor: palette.green, backgroundColor: palette.green },
  serviceProviderText: { color: palette.muted, fontSize: 10, fontWeight: "700", textAlign: "center" },
  serviceProviderTextSelected: { color: "#FFFFFF" },
  schoolSearchRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  schoolSearchInput: { flex: 1 },
  schoolSearchButton: { width: 43, height: 43, alignItems: "center", justifyContent: "center", borderRadius: 9, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.background },
  schoolResult: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: palette.line },
  parentChildrenSection: { marginTop: 18 },
  parentChildRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: palette.line },
  formTitle: { color: palette.ink, fontSize: 17, fontWeight: "700" },
  formDescription: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 5, marginBottom: 17 },
  inputLabel: { color: palette.ink, fontSize: 11, fontWeight: "700", marginBottom: 6 },
  input: { height: 45, color: palette.ink, fontSize: 13, borderWidth: 1, borderColor: palette.line, borderRadius: 9, paddingHorizontal: 12, marginBottom: 14, backgroundColor: "#FBFCFB" },
  rememberRow: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 14 },
  rememberText: { flex: 1, color: palette.muted, fontSize: 11, lineHeight: 16 },
  challengeOptions: { gap: 8, marginBottom: 16 },
  challengeOption: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderRadius: 9, backgroundColor: palette.background },
  challengeOptionText: { color: palette.ink, fontSize: 12, fontWeight: "600" },
  cancelText: { color: palette.muted, textAlign: "center", padding: 8, fontSize: 12 },
  privacyNote: { padding: 15, marginTop: 16, borderLeftWidth: 3, borderLeftColor: palette.blue, backgroundColor: "#E8EFF4" },
  privacyTitle: { color: palette.ink, fontSize: 12, fontWeight: "700" },
  privacyCopy: { color: palette.muted, fontSize: 11, lineHeight: 17, marginTop: 5 },
  notice: { color: palette.ink, fontSize: 11, lineHeight: 17, marginTop: 14, padding: 11, borderRadius: 9, backgroundColor: "#E6F1EC" },
  syncCaption: { color: palette.muted, fontSize: 10, textAlign: "center", marginTop: 13 },
  tabBar: { minHeight: 67, flexDirection: "row", borderTopWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF", paddingBottom: Platform.OS === "ios" ? 12 : 3 },
  tabItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4, position: "relative" },
  tabLabel: { color: palette.muted, fontSize: 10, fontWeight: "600" },
  tabLabelSelected: { color: palette.green, fontWeight: "800" },
  tabIndicator: { position: "absolute", top: 0, width: 24, height: 2, borderRadius: 1, backgroundColor: palette.green },
  serviceTabRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  serviceTabButton: { flex: 1, minHeight: 46, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 6, borderRadius: 10, borderWidth: 1.5, borderColor: palette.line, backgroundColor: palette.background },
  serviceTabButtonSelected: { borderColor: palette.green, backgroundColor: palette.green },
  serviceTabText: { color: palette.ink, fontSize: 11, fontWeight: "700" },
  serviceTabTextSelected: { color: "#FFFFFF" },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusDotConnected: { backgroundColor: "#2ECC71" },
  statusDotDisconnected: { backgroundColor: "#BDC3C7" },
  holidaysCard: { marginTop: 16, marginBottom: 16, padding: 15, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
  holidaysHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  holidaysTitle: { color: palette.ink, fontSize: 14, fontWeight: "800" },
  holidaysStatusText: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  holidaysToggleBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: "#E7F2ED" },
  holidaysToggleText: { color: palette.green, fontSize: 10, fontWeight: "700" },
  zoneRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  zoneLabel: { color: palette.muted, fontSize: 11, fontWeight: "700" },
  zoneChip: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.background },
  zoneChipSelected: { borderColor: palette.green, backgroundColor: palette.green },
  zoneChipText: { color: palette.ink, fontSize: 11, fontWeight: "700" },
  zoneChipTextSelected: { color: "#FFFFFF" },
  holidaysList: { marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: palette.line },
  holidayRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: palette.line },
  holidayRowActive: { backgroundColor: "#E7F2ED", paddingHorizontal: 8, borderRadius: 8 },
  holidayActiveText: { color: palette.green, fontWeight: "800" },
  holidayBadge: { fontSize: 10, fontWeight: "800", color: palette.green, backgroundColor: "#CBEBDC", paddingVertical: 2, paddingHorizontal: 6, borderRadius: 4 }
});
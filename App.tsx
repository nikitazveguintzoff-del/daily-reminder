import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  ArrowRight,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ClipboardList,
  GraduationCap,
  House,
  LogOut,
  Minus,
  Plus,
  RefreshCw,
  UserRound
} from "lucide-react-native";
import {
  createEdSession,
  fetchLoginChallenge,
  fetchSchoolData,
  login,
  relogin,
  resolveLoginChallenge,
  type EdSession,
  type LoginChallenge as EdLoginChallenge,
  type SchoolData
} from "./src/ecoleDirecte";
import {
  defaultPreferences,
  normalizeTime,
  scheduleDailyReminders,
  type ReminderPreferences
} from "./src/reminders";



type Tab = "journal" | "rappels" | "compte";
type LoginChallenge = {
  session: EdSession;
  username: string;
  password: string;
  uuid: string;
} & EdLoginChallenge;

const PREFS_KEY = "tempo-reminder-preferences";
const CREDENTIALS_KEY = "tempo-ecole-directe-credentials";
const DEVICE_KEY = "tempo-device-id";

const tabItems: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: "journal", label: "Journal", Icon: House },
  { id: "rappels", label: "Rappels", Icon: Bell },
  { id: "compte", label: "Compte", Icon: UserRound }
];

function frenchDate(): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(new Date());
}

function courseTime(value: string): string {
  return value.match(/\d{2}:\d{2}/)?.[0] ?? "--:--";
}

function shortDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(date);
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

export default function App() {
  const [tab, setTab] = useState<Tab>("journal");
  const [preferences, setPreferences] = useState<ReminderPreferences>(defaultPreferences);
  const [data, setData] = useState<SchoolData | null>(null);
  const [accountName, setAccountName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberCredentials, setRememberCredentials] = useState(false);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const sessionRef = useRef<EdSession | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      SecureStore.getItemAsync(PREFS_KEY),
      SecureStore.getItemAsync(CREDENTIALS_KEY)
    ]).then(async ([savedPreferences, savedCredentials]) => {
      if (!mounted) return;
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
          const saved = JSON.parse(savedCredentials) as { username: string; password: string };
          setUsername(saved.username);
          setPassword(saved.password);
          setRememberCredentials(true);
          if (saved.username && saved.password) {
            void performAutoLogin(saved.username, saved.password, activePrefs);
          }
        } catch {
          void SecureStore.deleteItemAsync(CREDENTIALS_KEY);
        }
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const performAutoLogin = async (
    userToUse: string,
    passToUse: string,
    prefsToUse: ReminderPreferences
  ) => {
    console.log("[APP] Starting auto-login...");
    setBusy(true);
    setNotice("");
    const session = createEdSession();
    const uuid = (await SecureStore.getItemAsync(DEVICE_KEY)) || Crypto.randomUUID();
    try {
      await login(session, userToUse.trim(), passToUse, uuid);
      sessionRef.current = session;
      const account = session.student;
      setAccountName([account?.prenom, account?.nom].filter(Boolean).join(" "));
      console.log("[APP] Auto-login succeeded. Fetching school data...");
      const latestData = await fetchSchoolData(session, prefsToUse.homeworkDays);
      setData(latestData);
      await scheduleDailyReminders(prefsToUse, latestData).catch(() => false);
      console.log("[APP] Auto-login & sync complete!");
    } catch (error) {
      console.error("[APP] Auto-login failed:", (error as Error).message);
      if ((error as { code?: number })?.code === 250) {
        setNotice("Vérification École Directe requise. Rendez-vous dans l'onglet Compte.");
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
    sessionRef.current = session;
    const account = session.student;
    setAccountName([account?.prenom, account?.nom].filter(Boolean).join(" "));
    setChallenge(null);
    if (rememberCredentials) {
      await SecureStore.setItemAsync(
        CREDENTIALS_KEY,
        JSON.stringify({
          username: currentUsername,
          password: currentPassword,
          accessToken: session.accessToken
        })
      );
      await SecureStore.setItemAsync(DEVICE_KEY, uuid);
    } else {
      await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
      await SecureStore.deleteItemAsync(DEVICE_KEY);
    }
    try {
      console.log("[APP] Fetching school data after login...");
      const latestData = await fetchSchoolData(session, preferences.homeworkDays);
      setData(latestData);
      await scheduleDailyReminders(preferences, latestData).catch(() => false);
      setNotice("Compte synchronisé. Les rappels utilisent ces données jusqu'à la prochaine synchronisation.");
      console.log("[APP] Connection and initial sync completed!");
    } catch (error) {
      console.error("[APP] Sync failed after login:", (error as Error).message);
      setData(null);
      await scheduleDailyReminders(preferences, null).catch(() => false);
      setNotice(`Compte connecté, mais synchronisation impossible : ${(error as Error).message}`);
    }
    setTab("journal");
  };

  const connect = async () => {
    console.log("[APP] User initiated login...");
    if (!username.trim() || !password) {
      setNotice("Renseigne ton identifiant et ton mot de passe.");
      return;
    }
    setBusy(true);
    setNotice("");
    const session = createEdSession();
    const uuid = (await SecureStore.getItemAsync(DEVICE_KEY)) || Crypto.randomUUID();
    try {
      await login(session, username.trim(), password, uuid);
      await finishConnection(session, username.trim(), password, uuid);
    } catch (error) {
      console.error("[APP] Login failed:", (error as Error).message);
      if ((error as { code?: number })?.code === 250) {
        try {
          const securityChallenge = await fetchLoginChallenge(session);
          setChallenge({
            session,
            username: username.trim(),
            password,
            uuid,
            ...securityChallenge
          });
          setNotice("Une vérification École Directe est nécessaire.");
        } catch (challengeError) {
          setNotice(`Connexion impossible : ${(challengeError as Error).message}`);
        }
      } else {
        setNotice(`Connexion impossible : ${(error as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const answerChallenge = async (answer: string) => {
    if (!challenge) return;
    setBusy(true);
    setNotice("");
    try {
      console.log("[APP] Answering 2FA challenge...");
      const factors = await resolveLoginChallenge(challenge.session, answer);
      await login(
        challenge.session,
        challenge.username,
        challenge.password,
        challenge.uuid,
        [factors]
      );
      await finishConnection(
        challenge.session,
        challenge.username,
        challenge.password,
        challenge.uuid
      );
    } catch (error) {
      console.error("[APP] Challenge resolution failed:", (error as Error).message);
      setNotice(`Vérification refusée : ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    console.log("[APP] Refreshing data...");
    if (!sessionRef.current && username.trim() && password) {
      console.log("[APP] No active session, attempting connect()...");
      await connect();
      return;
    }
    if (!sessionRef.current) return;
    setBusy(true);
    setNotice("");
    try {
      const latestData = await fetchSchoolData(sessionRef.current, preferences.homeworkDays);
      setData(latestData);
      await scheduleDailyReminders(preferences, latestData).catch(() => false);
      setNotice("Synchronisation terminée.");
      console.log("[APP] Refresh complete!");
    } catch (error) {
      console.error("[APP] Refresh error:", (error as Error).message, "Code:", (error as { code?: number })?.code);
      const errCode = (error as { code?: number })?.code;
      if ((errCode === 520 || errCode === 525) && username.trim() && password) {
        try {
          console.log("[APP] Session expired (520/525). Re-logging in automatically...");
          const session = createEdSession();
          const uuid = (await SecureStore.getItemAsync(DEVICE_KEY)) || Crypto.randomUUID();
          await login(session, username.trim(), password, uuid);
          sessionRef.current = session;
          const account = session.student;
          setAccountName([account?.prenom, account?.nom].filter(Boolean).join(" "));
          const latestData = await fetchSchoolData(session, preferences.homeworkDays);
          setData(latestData);
          await scheduleDailyReminders(preferences, latestData).catch(() => false);
          setNotice("Session renouvelée et synchronisation terminée.");
          console.log("[APP] Automatic re-login & refresh succeeded!");
          return;
        } catch (relogErr) {
          console.error("[APP] Automatic re-login failed:", (relogErr as Error).message);
        }
      }
      setNotice(`Synchronisation impossible : ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    Alert.alert("Déconnecter ce compte ?", "Les identifiants enregistrés seront supprimés de cet appareil.", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Déconnecter",
        style: "destructive",
        onPress: () => {
          sessionRef.current = null;
          setData(null);
          setAccountName("");
          setUsername("");
          setPassword("");
          setRememberCredentials(false);
          setNotice("");
          void SecureStore.deleteItemAsync(CREDENTIALS_KEY);
          void SecureStore.deleteItemAsync(DEVICE_KEY);
        }
      }
    ]);
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
    if (sessionRef.current) {
      try {
        latestData = await fetchSchoolData(sessionRef.current, normalizedPrefs.homeworkDays);
        setData(latestData);
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

  const updateReminder = (key: "classes" | "homework" | "grades", update: { enabled?: boolean; time?: string }) => {
    setPreferences((current) => ({
      ...current,
      [key]: { ...current[key], ...update }
    }));
  };

  const renderJournal = () => (
    <>
      <View style={styles.hero}>
        <View style={styles.heroTopline}>
          <Text style={styles.heroEyebrow}>TON JOUR EN UN COUP D'OEIL</Text>
          <CalendarDays color="#B9E9D9" size={19} />
        </View>
        <Text style={styles.heroDate}>{frenchDate()}</Text>
        <Text style={styles.heroCopy}>
          {data
            ? `${data.courses.length} cours aujourd'hui · ${data.homeworks.length} devoir${data.homeworks.length === 1 ? "" : "s"} à venir`
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
        <Text style={styles.sectionTitle}>Aujourd'hui</Text>
        {data && (
          <Pressable accessibilityLabel="Synchroniser" onPress={() => void refresh()} style={styles.iconButton}>
            {busy ? <ActivityIndicator color={palette.green} /> : <RefreshCw size={18} color={palette.green} />}
          </Pressable>
        )}
      </View>

      <View style={styles.summaryRow}>
        <View style={[styles.summaryBlock, styles.summaryMint]}>
          <BookOpen size={18} color={palette.green} />
          <Text style={styles.summaryValue}>{data ? data.courses.length : "—"}</Text>
          <Text style={styles.summaryLabel}>cours</Text>
        </View>
        <View style={[styles.summaryBlock, styles.summaryPeach]}>
          <ClipboardList size={18} color={palette.coral} />
          <Text style={styles.summaryValue}>{data ? data.homeworks.length : "—"}</Text>
          <Text style={styles.summaryLabel}>devoirs</Text>
        </View>
        <View style={[styles.summaryBlock, styles.summaryBlue]}>
          <GraduationCap size={19} color={palette.blue} />
          <Text style={styles.summaryValue}>{data?.latestGrade?.value ?? "—"}</Text>
          <Text style={styles.summaryLabel}>dernière note</Text>
        </View>
      </View>

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>Emploi du temps</Text>
        <Text style={styles.sectionMeta}>{data ? `${data.courses.length} cours` : "École Directe"}</Text>
      </View>
      <View style={styles.listSection}>
        {!data && <EmptyLine>Connecte ton compte pour afficher les cours de la journée.</EmptyLine>}
        {data?.courses.length === 0 && <EmptyLine>Aucun cours prévu aujourd'hui.</EmptyLine>}
        {data?.courses.map((course, index) => (
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

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>À préparer</Text>
        <Text style={styles.sectionMeta}>{preferences.homeworkDays} jours</Text>
      </View>
      <View style={styles.listSection}>
        {!data && <EmptyLine>Les devoirs à venir apparaîtront ici après connexion.</EmptyLine>}
        {data?.homeworks.length === 0 && <EmptyLine>Aucun devoir sur cette période.</EmptyLine>}
        {data?.homeworks.slice(0, 5).map((homework, index) => (
          <View key={`${homework.subject}-${homework.dueDate}-${index}`} style={styles.homeworkRow}>
            <View style={styles.homeworkMark} />
            <View style={styles.rowContent}>
              <Text style={styles.rowTitle}>{homework.subject}</Text>
              <Text style={styles.rowDetail} numberOfLines={2}>{homework.content}</Text>
            </View>
            <Text style={styles.dueDate}>{shortDate(homework.dueDate)}</Text>
          </View>
        ))}
      </View>

      <View style={styles.gradeStrip}>
        <GraduationCap size={21} color={palette.blue} />
        <View style={styles.rowContent}>
          <Text style={styles.rowTitle}>Dernière note reçue</Text>
          <Text style={styles.rowDetail}>
            {data?.latestGrade
              ? `${data.latestGrade.subject} · ${shortDate(data.latestGrade.date)}`
              : data
                ? "Aucune note récente"
                : "Connecte ton compte pour retrouver tes notes."}
          </Text>
        </View>
        <Text style={styles.gradeValue}>{data?.latestGrade?.value ?? "—"}</Text>
      </View>
    </>
  );

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
      <View style={styles.horizonRow}>
        <View style={styles.rowContent}>
          <Text style={styles.rowTitle}>Période des devoirs</Text>
          <Text style={styles.rowDetail}>Nombre de jours à afficher</Text>
        </View>
        <View style={styles.stepper}>
          <Pressable
            accessibilityLabel="Réduire la période"
            onPress={() => setPreferences((current) => ({ ...current, homeworkDays: Math.max(1, current.homeworkDays - 1) }))}
            style={styles.stepButton}
          >
            <Minus size={16} color={palette.ink} />
          </Pressable>
          <Text style={styles.stepValue}>{preferences.homeworkDays}</Text>
          <Pressable
            accessibilityLabel="Augmenter la période"
            onPress={() => setPreferences((current) => ({ ...current, homeworkDays: Math.min(14, current.homeworkDays + 1) }))}
            style={styles.stepButton}
          >
            <Plus size={16} color={palette.ink} />
          </Pressable>
        </View>
      </View>
      <ReminderRow
        title="Dernières notes"
        detail="Quand une note est disponible"
        time={preferences.grades.time}
        enabled={preferences.grades.enabled}
        color={palette.blue}
        onTime={(time) => updateReminder("grades", { time })}
        onEnabled={(enabled) => updateReminder("grades", { enabled })}
      />
      <View style={styles.reminderNote}>
        <Bell size={17} color={palette.green} />
        <Text style={styles.reminderNoteText}>
          Le contenu des rappels reflète la dernière synchronisation. Ouvre Journal et actualise pour le mettre à jour.
        </Text>
      </View>
      <AppButton label="Enregistrer les horaires" onPress={() => void savePreferences()} icon={<Check size={17} color="#FFFFFF" />} />
    </>
  );

  const renderAccount = () => (
    <>
      <View style={styles.pageIntro}>
        <Text style={styles.pageTitle}>Ton compte</Text>
        <Text style={styles.pageDescription}>Connexion directe à École Directe, sans serveur intermédiaire.</Text>
      </View>
      {sessionRef.current ? (
        <View style={styles.accountPanel}>
          <View style={styles.accountBadge}><UserRound size={22} color={palette.green} /></View>
          <Text style={styles.accountName}>{accountName || "Compte connecté"}</Text>
          <Text style={styles.accountStatus}>Synchronisé à {data ? new Date(data.syncedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "l'instant"}</Text>
          <View style={styles.accountActions}>
            <AppButton
              label="Actualiser"
              onPress={() => void refresh()}
              icon={busy ? <ActivityIndicator color="#FFFFFF" /> : <RefreshCw size={17} color="#FFFFFF" />}
              disabled={busy}
            />
            <Pressable accessibilityRole="button" accessibilityLabel="Déconnecter" onPress={signOut} style={styles.logoutButton}>
              <LogOut size={18} color={palette.coral} />
            </Pressable>
          </View>
        </View>
      ) : challenge ? (
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
      ) : (
        <View style={styles.loginPanel}>
          <Text style={styles.formTitle}>Se connecter</Text>
          <Text style={styles.formDescription}>Utilise les identifiants de ton espace École Directe.</Text>
          <Text style={styles.inputLabel}>Identifiant</Text>
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
          <View style={styles.rememberRow}>
            <Switch
              value={rememberCredentials}
              onValueChange={setRememberCredentials}
              trackColor={{ false: "#D4DBD7", true: "#76CBB0" }}
              thumbColor={rememberCredentials ? palette.green : "#FFFFFF"}
            />
            <Text style={styles.rememberText}>Garder les identifiants sur cet appareil</Text>
          </View>
          <AppButton
            label={busy ? "Connexion…" : "Se connecter"}
            onPress={() => void connect()}
            icon={busy ? <ActivityIndicator color="#FFFFFF" /> : <ArrowRight size={17} color="#FFFFFF" />}
            disabled={busy}
          />
        </View>
      )}
      <View style={styles.privacyNote}>
        <Text style={styles.privacyTitle}>Tes données restent sur ton téléphone</Text>
        <Text style={styles.privacyCopy}>
          La connexion suit la documentation publique de l'API non officielle d'École Directe. Les identifiants facultativement mémorisés sont conservés dans le stockage sécurisé du téléphone.
        </Text>
      </View>
    </>
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.brandMark}><CalendarDays size={19} color="#FFFFFF" /></View>
        <View style={styles.brandTextWrap}>
          <Text style={styles.brand}>tempo</Text>
          <Text style={styles.brandCaption}>ÉCOLE DIRECTE, EN CLAIR</Text>
        </View>
        <View style={[styles.connectionDot, data ? styles.connectionOnline : styles.connectionOffline]} />
        <Text style={styles.connectionLabel}>{data ? "Connecté" : "Hors ligne"}</Text>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {!!notice && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
        {tab === "journal" && renderJournal()}
        {tab === "rappels" && renderReminders()}
        {tab === "compte" && renderAccount()}
        {data && <Text style={styles.syncCaption}>Dernière synchro {new Date(data.syncedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</Text>}
      </ScrollView>

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
  iconButton: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: "#E7F2ED" },
  summaryRow: { flexDirection: "row", gap: 8 },
  summaryBlock: { flex: 1, minHeight: 103, borderRadius: 14, padding: 12, justifyContent: "space-between" },
  summaryMint: { backgroundColor: "#E2F1EA" },
  summaryPeach: { backgroundColor: "#F8E8E0" },
  summaryBlue: { backgroundColor: "#E5EDF3" },
  summaryValue: { color: palette.ink, fontSize: 19, fontWeight: "700", marginTop: 8 },
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
  homeworkMark: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.coral },
  dueDate: { color: palette.coral, fontSize: 10, fontWeight: "700", marginLeft: 5 },
  gradeStrip: { flexDirection: "row", gap: 12, alignItems: "center", padding: 15, marginTop: 17, borderRadius: 14, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
  gradeValue: { color: palette.blue, fontSize: 15, fontWeight: "800", marginLeft: 6 },
  pageIntro: { marginTop: 18, marginBottom: 18 },
  pageTitle: { color: palette.ink, fontSize: 27, fontWeight: "800" },
  pageDescription: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 6 },
  reminderRow: { minHeight: 84, flexDirection: "row", alignItems: "center", gap: 9, borderBottomWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF", paddingHorizontal: 12, marginBottom: 1 },
  reminderAccent: { width: 4, height: 39, borderRadius: 2, marginRight: 2 },
  timeInput: { minWidth: 57, color: palette.ink, fontSize: 14, fontWeight: "700", textAlign: "center", backgroundColor: palette.background, borderRadius: 8, paddingHorizontal: 5, paddingVertical: 8 },
  horizonRow: { minHeight: 75, flexDirection: "row", alignItems: "center", backgroundColor: "#FFFFFF", borderBottomWidth: 1, borderColor: palette.line, paddingHorizontal: 14 },
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
  accountPanel: { alignItems: "center", padding: 20, borderRadius: 16, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
  accountBadge: { width: 50, height: 50, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: "#E2F1EA" },
  accountName: { color: palette.ink, fontSize: 17, fontWeight: "700", marginTop: 13 },
  accountStatus: { color: palette.muted, fontSize: 11, marginTop: 5 },
  accountActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 19, width: "100%" },
  logoutButton: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: "#F8E8E0" },
  loginPanel: { padding: 17, borderRadius: 16, borderWidth: 1, borderColor: palette.line, backgroundColor: "#FFFFFF" },
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
  tabIndicator: { position: "absolute", top: 0, width: 24, height: 2, borderRadius: 1, backgroundColor: palette.green }
});
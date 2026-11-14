const { test } = require("node:test");
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const path = require("node:path");

async function load(entry, fixture, mocks) {
  const result = await build({
    entryPoints: [path.join(__dirname, "..", entry)], bundle: true, write: false,
    platform: "node", format: "cjs",
    plugins: [{
      name: "test-dependencies",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path: name }) => mocks[name] ? { path: name, namespace: "mock" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path: name }) => ({ contents: mocks[name], loader: "js" }));
      }
    }]
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "fixture", result.outputFiles[0].text)(module, module.exports, require, fixture);
  return module.exports;
}
const storeMock = `export const getItemAsync = async key => fixture.store.get(key) ?? null;
export const setItemAsync = async (key,value) => { fixture.store.set(key,value); };
export const deleteItemAsync = async key => { fixture.store.delete(key); };`;
const edMock = `export const fetchSchoolData = (...args) => fixture.ed(...args);
export const createEdSession = () => ({ pupils: [{id:1}] });
export const relogin = async () => { fixture.restored.push("ecoleDirecte"); };
export const fetchStudentsSchoolDataWithAutoAdvance = () => { throw Error("Unexpected legacy sync"); };
export const fetchCourseSlots = async (...args) => (fixture.slots?.ecoleDirecte ?? (() => []))(...args);`;
const servicesMock = `export const fetchPronoteData = (...args) => fixture.pronote(...args);
export const fetchSkolengoData = (...args) => fixture.skolengo(...args);
export const fetchPronoteCourseSlots = async (...args) => (fixture.slots?.pronote ?? (() => []))(...args);
export const fetchSkolengoCourseSlots = async (...args) => (fixture.slots?.skolengo ?? (() => []))(...args);
export const restorePronote = async (token, save) => {
fixture.restored.push("pronote"); await save("renewed-pronote"); return { session: {}, refreshToken: "renewed-pronote" }; };
export const restoreSkolengoLogin = async () => {
fixture.restored.push("skolengo"); return { account: {refreshToken:"renewed-skolengo"} }; };`;
const data = (subject) => ({ student: { id: 1 }, courses: [{ subject }], homeworks: [{ subject }], grades: [{ subject }], competencies: [] });
const child = (id = "one") => ({
  id, firstName: id, lastName: "Test", links: {
    ecoleDirecte: { accountId: "ed", studentId: "1" },
    pronote: { accountId: "pn", studentId: id },
    skolengo: { accountId: "sk", studentId: id }
  },
  sources: { courses: "skolengo", homeworks: "pronote", grades: "ecoleDirecte", photo: "pronote" }
});
const accounts = [
  { id: "ed", provider: "ecoleDirecte", students: [] },
  { id: "pn", provider: "pronote", students: [] },
  { id: "sk", provider: "skolengo", students: [], school: {} }
];
function fixture() {
  return { store: new Map(), ed: async () => data("ed"), pronote: async () => ({ ...data("pn"), studentPhoto: "data:image/png;base64,photo" }), skolengo: async () => data("sk"), restored: [] };
}
const mocks = {
  "./ecoleDirecte": edMock, "../ecoleDirecte": edMock,
  "./providers/schoolServices": servicesMock,
  "expo-secure-store": storeMock
};

test("first course day skips ended and cancelled courses, today included", async () => {
  const { firstCourseDay } = await load("src\\courseDay.ts", {}, {});
  const now = new Date(2025, 2, 10, 10, 0); // Monday 10:00
  const day = (value) => value && `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()} ${value.getHours()}h`;
  assert.equal(day(firstCourseDay([{ start: "2025-03-10 09:00", end: "2025-03-10 11:00" }], now)), "2025-3-10 12h");
  assert.equal(day(firstCourseDay([
    { start: "2025-03-10 08:00", end: "2025-03-10 09:00" },
    { start: "2025-03-10 14:00", end: "2025-03-10 15:00", canceled: true },
    { start: "2025-03-12 08:00", end: "2025-03-12 09:00" },
    { start: "2025-03-11T13:00:00", end: "2025-03-11T14:00:00" }
  ], now)), "2025-3-11 12h");
  assert.equal(firstCourseDay([{ start: "2025-03-09 08:00", end: "2025-03-09 09:00" }], now), undefined);
});

test("sync day selection uses each child's timetable source and falls back to today", async () => {
  const context = fixture();
  const requested = [];
  context.slots = {
    skolengo: (_session, studentId) => { requested.push(`sk:${studentId}`); return [{ start: "2099-01-05 08:00", end: "2099-01-05 09:00" }]; },
    pronote: () => { throw Error("Pronote down"); }
  };
  const { findFirstCourseDay } = await load("src\\sync.ts", context, mocks);
  const sessions = new Map([["ed", { pupils: [{ id: 1 }] }], ["pn", {}], ["sk", {}]]);
  const children = [child("one"), child("two"), { ...child("three"), sources: { ...child("three").sources, courses: "pronote" } }];
  const now = new Date(2099, 0, 3, 10);
  const selected = await findFirstCourseDay(children, accounts, sessions, now);
  assert.deepEqual(requested, ["sk:one", "sk:two"]);
  assert.equal(selected.getDate(), 5);
  context.slots = {};
  const fallback = await findFirstCourseDay(children, accounts, sessions, now);
  assert.equal(fallback.getDate(), 3);
  assert.equal(fallback.getHours(), 12);
});

test("saving stale account metadata never overwrites a rotated token", async () => {
  const context = fixture();
  const storage = await load("src\\accountStorage.ts", context, { "expo-secure-store": storeMock });
  const key = storage.providerTokenKey("pn");
  context.store.set(key, "rotated");
  await storage.persistProviderAccounts([{ ...accounts[1], refreshToken: "stale" }], true);
  assert.equal(context.store.get(key), "rotated");
  await storage.persistProviderAccounts([{ ...accounts[1], refreshToken: "stale" }], false);
  assert.equal(context.store.has(key), false);
});

test("syncs every child and honours mixed sources including photos", async () => {
  const { syncChildren } = await load("src\\sync.ts", fixture(), mocks);
  const listed = accounts.map((account) => ({ ...account, students: [{ id: account.provider === "ecoleDirecte" ? "1" : "one", photo: "//doc1.invalid/raw.jpg" }] }));
  const result = await syncChildren([child(), child("two")], listed, new Map([["ed", { pupils: [{ id: 1 }] }], ["pn", {}], ["sk", {}]]), new Date(), 3);
  // Account lists show the downloaded photo instead of the raw, header-protected URL.
  assert.equal(listed.find((account) => account.id === "pn").students[0].photo, "data:image/png;base64,photo");
  assert.equal(listed.find((account) => account.id === "ed").students[0].photo, "//doc1.invalid/raw.jpg");
  assert.equal(result.length, 2);
  for (const entry of result) {
    assert.equal(entry.courses[0].subject, "sk");
    assert.equal(entry.homeworks[0].subject, "pn");
    assert.equal(entry.grades[0].subject, "ed");
    assert.equal(entry.student.photo, "data:image/png;base64,photo");
    assert.equal(entry.error, undefined);
  }
});
test("a failed selected provider remains an error even when other sources succeed", async () => {
  const context = fixture();
  context.pronote = async () => { throw Error("Expired session"); };
  const { syncChildren } = await load("src\\sync.ts", context, mocks);
  const [entry] = await syncChildren([child()], accounts, new Map([["ed", { pupils: [{ id: 1 }] }], ["pn", {}], ["sk", {}]]), new Date(), 3);
  assert.match(entry.error, /Expired session/);
  assert.equal(entry.courses[0].subject, "sk");
});
test("missing sessions are reported, disabled domains stay empty", async () => {
  const { syncChildren } = await load("src\\sync.ts", fixture(), mocks);
  const item = child();
  item.sources.grades = null;
  const [entry] = await syncChildren([item], accounts, new Map(), new Date(), 3);
  assert.match(entry.error, /skolengo/);
  assert.match(entry.error, /pronote/);
  assert.deepEqual(entry.grades, []);
});
test("Android task restores all three providers and saves rotated tokens", async () => {
  const context = fixture();
  context.store.set("tempo-background-sync-enabled", "true");
  context.store.set("tempo-provider-accounts-v1", JSON.stringify(accounts));
  context.store.set("tempo-children-profiles-v3", JSON.stringify([child(), child("two")]));
  context.store.set("tempo-ecole-directe-credentials", JSON.stringify({ username: "test", accessToken: "ed-token" }));
  context.store.set("tempo-device-id", "device");
  const taskMocks = {
    ...mocks,
    "react-native": `export const Platform = {OS:"android"}; export const AppState={currentState:"background"};`,
    "expo-task-manager": `export const defineTask = (name, task) => { fixture.task=task; };
      export const isTaskRegisteredAsync=async()=>false;`,
    "expo-background-task": `export const BackgroundTaskResult={Success:1,Failed:2};
      export const BackgroundTaskStatus={Available:1}; export const getStatusAsync=async()=>1;
      export const registerTaskAsync=async()=>{}; export const unregisterTaskAsync=async()=>{};`,
    "expo-notifications": `export const getPermissionsAsync = async () => ({granted:true});`,
    "./reminders": `export const defaultPreferences={homeworkDays:3}; export const sendRemindersAfterSync=async () => {fixture.notified=true;return 1;};`
  };
  const { providerTokenKey } = await load("src\\accountStorage.ts", context, { "expo-secure-store": storeMock });
  context.store.set(providerTokenKey("pn"), "pn-token");
  context.store.set(providerTokenKey("sk"), "sk-token");
  const background = await load("src\\backgroundSync.ts", context, taskMocks);
  context.store.delete(providerTokenKey("sk"));
  await assert.rejects(background.enableBackgroundSync(), /Reconnecte/);
  context.store.set(providerTokenKey("sk"), "sk-token");
  assert.equal(await context.task({}), 1);
  assert.deepEqual(context.restored, ["ecoleDirecte", "pronote", "skolengo"]);
  assert.equal(context.store.get(providerTokenKey("pn")), "renewed-pronote");
  assert.equal(context.store.get(providerTokenKey("sk")), "renewed-skolengo");
  assert.equal(JSON.parse(context.store.get("tempo-background-sync-data")).length, 2);
  assert.equal(context.notified, true);
  context.pronote = async () => { throw Error("Provider offline"); };
  context.notified = false;
  assert.equal(await context.task({}), 2);
  assert.equal(context.notified, false);
  assert.equal(JSON.parse(context.store.get("tempo-background-sync-status")).succeeded, false);
  context.store.set("tempo-provider-accounts-v1", JSON.stringify([accounts[2]]));
  const onlySkolengo = child();
  onlySkolengo.sources = { courses: "skolengo", homeworks: "skolengo", grades: "skolengo", photo: null };
  context.store.set("tempo-children-profiles-v3", JSON.stringify([onlySkolengo]));
  context.store.delete("tempo-ecole-directe-credentials");
  await background.enableBackgroundSync();
  assert.equal(await context.task({}), 1);
});

test("Pronote saves its rotated token before photos, downloads sequentially and validates image bytes", async () => {
  const context = { store: new Map(), active: 0, max: 0, saved: false };
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  context.session = {
    info: { name: "Test" },
    exportCredentials: () => ({ username: "test", password: "renewed", uuid: "uuid" }),
    children: [1, 2].map((id) => ({
      id: String(id), name: "Test Child", className: "Test",
      profilePicture: { url: "https://school.invalid/photo.jpg", data: async () => {
        assert.equal(context.saved, true);
        context.max = Math.max(context.max, ++context.active);
        await new Promise(resolve => setTimeout(resolve, 5));
        context.active--;
        return image;
      } }
    }))
  };
  const api = await load("src\\providers\\schoolServices.ts", context, {
    "expo-secure-store": storeMock,
    "pronotets": `export class Homework {} export const ParentClient={tokenLogin:async()=>fixture.session};`,
    "skolengojs": `export const ChallengeMethod={}; export const GetOIDCWellKnown=()=>{}; export const LoginWithToken=()=>{}; export const SearchSchools=()=>{}; export class School {}`,
    "../photos": `export const inlinePhoto=async () => { throw Error("Unexpected unauthenticated photo fallback"); };
export const cachedPhoto=(key, download) => download();
export const photoCacheKey=(provider, id) => provider + ":" + id;`
  });
  const result = await api.connectPronoteSso({ url: "https://school.invalid/pronote", username: "test", token: "old", uuid: "uuid" }, async (token) => {
    assert.equal(JSON.parse(token).token, "renewed");
    context.saved = true;
  });
  assert.equal(context.max, 1);
  assert.equal(result.students[0].photo, `data:image/png;base64,${image.toString("base64")}`);
  const invalidChild = { ...context.session.children[0], profilePicture: {
    url: undefined, data: async () => Buffer.from("<html>login required</html>")
  } };
  context.session.children = [invalidChild];
  // No URL means an invalid attachment must not be accepted as a JPEG.
  const invalidApi = await load("src\\providers\\schoolServices.ts", context, {
    "expo-secure-store": storeMock,
    "pronotets": `export class Homework {} export const ParentClient={tokenLogin:async()=>fixture.session};`,
    "skolengojs": `export const ChallengeMethod={}; export const GetOIDCWellKnown=()=>{}; export const LoginWithToken=()=>{}; export const SearchSchools=()=>{}; export class School {}`,
    "../photos": `export const inlinePhoto=async () => undefined;
export const cachedPhoto=(key, download) => download();
export const photoCacheKey=(provider, id) => provider + ":" + id;`
  });
  const invalid = await invalidApi.connectPronoteSso({ url: "https://school.invalid/pronote", username: "test", token: "old", uuid: "uuid" });
  assert.equal(invalid.students[0].photo, undefined);
});

test("Pronote photo URL uses a single AES padding when the library URL answers 404", async () => {
  const { pathToFileURL } = require("node:url");
  const crypto = require("node:crypto");
  const dist = path.join(__dirname, "..", "node_modules", "pronotets", "dist");
  const { ClientInfo } = await import(pathToFileURL(path.join(dist, "dataClasses.js")).href);
  const { Encryption } = await import(pathToFileURL(path.join(dist, "crypto.js")).href);
  const encryption = new Encryption();
  encryption.aesKey = crypto.createHash("md5").update("synthetic-key").digest();
  encryption.aesIv = crypto.createHash("md5").update("synthetic-iv").digest();
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const requested = [];
  const client = {
    attributes: { h: "42" },
    communication: {
      rootSite: "https://school.invalid/pronote", encryption,
      session: { get: async (url) => {
        requested.push(url);
        const magic = url.split("/FichiersExternes/")[1].split("/")[0];
        const decipher = crypto.createDecipheriv("aes-128-cbc", encryption.aesKey, encryption.aesIv);
        const entity = Buffer.concat([decipher.update(Buffer.from(magic, "hex")), decipher.final()]).toString("utf8");
        // Like Pronote, accept only an entity that is exactly the JSON identifier once unpadded.
        return entity === '{"N":"child-1","Actif":true}'
          ? { status: 200, content: image }
          : { status: 404, content: Buffer.from("Not found") };
      } }
    }
  };
  const child = new ClientInfo(client, { N: "child-1", L: "Test Child", avecPhoto: true });
  const context = { store: new Map(), session: {
    info: { name: "Test" }, exportCredentials: () => ({ username: "test", password: "renewed", uuid: "uuid" }), children: [child]
  } };
  assert.equal((await client.communication.session.get(child.profilePicture.url)).status, 404);
  requested.length = 0;
  const api = await load("src\\providers\\schoolServices.ts", context, {
    "expo-secure-store": storeMock,
    "pronotets": `export class Homework {} export const ParentClient={tokenLogin:async()=>fixture.session};`,
    "skolengojs": `export const ChallengeMethod={}; export const GetOIDCWellKnown=()=>{}; export const LoginWithToken=()=>{}; export const SearchSchools=()=>{}; export class School {}`,
    "../photos": `export const inlinePhoto=async () => undefined;
export const cachedPhoto=(key, download) => download();
export const photoCacheKey=(provider, id) => provider + ":" + id;`
  });
  const result = await api.connectPronoteSso({ url: "https://school.invalid/pronote", username: "test", token: "old", uuid: "uuid" });
  assert.equal(result.students[0].photo, `data:image/jpeg;base64,${image.toString("base64")}`);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /^https:\/\/school\.invalid\/pronote\/FichiersExternes\/[0-9a-f]+\/photo\.jpg\?Session=42$/);
});

test("Pronote photo embedded in ParametresUtilisateur (photoBase64) is used without any download", async () => {
  const { pathToFileURL } = require("node:url");
  const crypto = require("node:crypto");
  const dist = path.join(__dirname, "..", "node_modules", "pronotets", "dist");
  const { ClientInfo } = await import(pathToFileURL(path.join(dist, "dataClasses.js")).href);
  const { Encryption } = await import(pathToFileURL(path.join(dist, "crypto.js")).href);
  const encryption = new Encryption();
  encryption.aesKey = crypto.createHash("md5").update("synthetic-key").digest();
  encryption.aesIv = crypto.createHash("md5").update("synthetic-iv").digest();
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
  const client = {
    attributes: { h: "42" },
    parametresUtilisateur: { dataSec: { data: {} }, dataNonSec: { fichiers: ["unused", image.toString("base64")] } },
    communication: { rootSite: "https://school.invalid/pronote", encryption, session: { get: async () => { throw Error("Unexpected photo download"); } } }
  };
  const child = new ClientInfo(client, { N: "child-1", L: "Test Child", avecPhoto: true, photoBase64: 1 });
  const context = { store: new Map(), session: {
    info: { name: "Test" }, exportCredentials: () => ({ username: "test", password: "renewed", uuid: "uuid" }), children: [child]
  } };
  const api = await load("src\\providers\\schoolServices.ts", context, {
    "expo-secure-store": storeMock,
    "pronotets": `export class Homework {} export const ParentClient={tokenLogin:async()=>fixture.session};`,
    "skolengojs": `export const ChallengeMethod={}; export const GetOIDCWellKnown=()=>{}; export const LoginWithToken=()=>{}; export const SearchSchools=()=>{}; export class School {}`,
    "../photos": `export const inlinePhoto=async () => undefined;
export const cachedPhoto=(key, download) => download();
export const photoCacheKey=(provider, id) => provider + ":" + id;`
  });
  const result = await api.connectPronoteSso({ url: "https://school.invalid/pronote", username: "test", token: "old", uuid: "uuid" });
  assert.equal(result.students[0].photo, `data:image/jpeg;base64,${image.toString("base64")}`);
});

test("student photos are downloaded once, reused from storage and kept when a refresh fails", async () => {
  const photos = await load("src\\photos.ts", {}, {});
  const disk = new Map();
  photos.setPhotoStore({
    read: async (key) => disk.get(key),
    write: async (key, dataUri) => { disk.set(key, { dataUri, savedAt: Date.now() }); },
    remove: async (key) => { disk.delete(key); }
  });
  const key = photos.photoCacheKey("pronote", "42");
  let downloads = 0;
  const download = async () => { downloads++; return "data:image/png;base64,fresh"; };
  assert.equal(await photos.cachedPhoto(key, download), "data:image/png;base64,fresh");
  assert.equal(await photos.cachedPhoto(key, download), "data:image/png;base64,fresh");
  assert.equal(downloads, 1);

  await photos.forgetPhoto(key);
  assert.equal(disk.has(key), false);
  disk.set(key, { dataUri: "data:image/png;base64,recent", savedAt: Date.now() - 86400000 });
  assert.equal(await photos.cachedPhoto(key, download), "data:image/png;base64,recent");
  assert.equal(downloads, 1);

  await photos.forgetPhoto(key);
  disk.set(key, { dataUri: "data:image/png;base64,old", savedAt: 0 });
  assert.equal(await photos.cachedPhoto(key, async () => undefined), "data:image/png;base64,old");
  assert.equal(await photos.storedPhoto(key), "data:image/png;base64,old");
});

test("Skolengo children share refreshed credentials without reusing the old refresh token", async () => {
  const context = { store: new Map() };
  const api = await load("src\\providers\\schoolServices.ts", context, {
    "expo-secure-store": storeMock,
    "pronotets": `export class Homework {} export const ParentClient={};`,
    "skolengojs": `export const ChallengeMethod={}; export const GetOIDCWellKnown=()=>{}; export const LoginWithToken=()=>{}; export const SearchSchools=()=>{}; export class School {}`
  });
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64")}.signature`;
  let rotations = 0;
  const account = {
    accessToken: jwt, accessTokenTTL: 0, refreshToken: "old", school: { id: "school", emsCode: "ems" },
    refreshAccessToken: async function () {
      if (Date.now() < this.accessTokenTTL) return false;
      assert.equal(this.refreshToken, "old");
      this.refreshToken = "new";
      rotations++;
      return true;
    },
    kids: [1, 2].map((id) => ({
      userId: String(id), accessToken: "old-access", refreshToken: "old", accessTokenTTL: 0,
      school: { id: "school", emsCode: "ems" },
      refreshAccessToken: async function () {
        assert.ok(this.accessTokenTTL > Date.now());
        assert.equal(this.refreshToken, "new");
        return false;
      },
      GetAssignments: async function () { await this.refreshAccessToken(); return []; },
      GetLastGrades: async function () { await this.refreshAccessToken(); return []; }
    }))
  };
  const saved = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.ok(saved.length > 0 && saved.every((token) => token === "new"));
    return new Response(JSON.stringify({ data: [], included: [] }), { status: 200 });
  };
  try {
    await Promise.all(account.kids.map((student) => api.fetchSkolengoData(account, student.userId, new Date(), 3, async (token) => saved.push(token))));
    assert.equal(rotations, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("Pronote accepts an omitted homework list, includes today's homework and rejects malformed data", async () => {
  const context = { store: new Map(), date: new Date(2026, 10, 11), response: { dataSec: { data: {} } } };
  const api = await load("src\\providers\\schoolServices.ts", context, {
    "expo-secure-store": storeMock,
    "pronotets": `export const ParentClient={};
      export class Homework { constructor() { this.date=fixture.date; this.subject={name:"Test"}; this.description="Test"; this.done=false; } }`,
    "skolengojs": `export const ChallengeMethod={}; export const GetOIDCWellKnown=()=>{}; export const LoginWithToken=()=>{}; export const SearchSchools=()=>{}; export class School {}`
  });
  const session = {
    children: [{ id: "child", profilePicture: null }], setChild: () => {},
    lessons: async () => [], currentPeriod: async () => ({ grades: async () => [] }),
    getWeek: () => 1, post: async () => context.response,
    pronoteUrl: "https://school.invalid/pronote/mobile.parent.html",
    exportCredentials: () => ({ username: "test", password: "automatically-renewed", uuid: "uuid" })
  };
  const midday = new Date(2026, 10, 11, 14);
  assert.deepEqual((await api.fetchPronoteData(session, "child", midday, 3)).homeworks, []);
  context.response.dataSec.data = { ListeTravauxAFaire: { V: [{}] } };
  assert.equal((await api.fetchPronoteData(session, "child", midday, 3)).homeworks.length, 1);
  context.response.dataSec.data = { ListeTravauxAFaire: { V: "invalid" } };
  let saved;
  await assert.rejects(api.fetchPronoteData(session, "child", midday, 3, async (token) => { saved = JSON.parse(token); }), /Liste des devoirs Pronote invalide/);
  assert.equal(saved.token, "automatically-renewed");
});

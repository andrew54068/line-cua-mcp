// line-reader.c — "LINE Reader.app", the only process in line-cua-mcp that
// touches LINE Desktop's own folders.
//
// macOS protects other apps' data ("<App> would like to access data from other
// apps"). A prompt names the process that asks, so this small named app does
// every such read and shows NSAppDataUsageDescription as its purpose. Python
// and Node then work only on the copies in a private folder.
//
// It copies; it never writes to LINE's folders, uses no network, runs no
// scripts, and loads no user-writable code (hardened runtime + library
// validation). So a grant to LINE Reader cannot be borrowed to run other code:
// the most a caller gets is a copy of LINE's own data.
//
// Launch it through LaunchServices so it is the responsible process:
//   open -W -n -g -j -a "LINE Reader.app" --args <command> ...
//
// Commands (DIR: an existing folder owned by you with mode 0700):
//   snapshot --out DIR [--key-fifo FIFO]   copy the message DB (+ -wal/-shm) to DIR/m.edb*
//                                          and, with FIFO (inside DIR), send the DB key
//   copy --out DIR FILE...                 copy files from LINE's data folder to DIR/f<N>
//   list --out DIR FOLDER                  list files under a folder in LINE's data folder
// Each run writes DIR/result.json: {"ok":true,...} or {"ok":false,"error":"..."}.

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <fts.h>
#include <limits.h>
#include <pwd.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define DB_REL "/Library/Containers/jp.naver.line.mac/Data/Library/Containers/jp.naver.line/Data/db"
#define DATA_REL "/Library/Group Containers/VUTU7AKEUR.jp.naver.line.mac/Real/Library/Data"
#define KEY_SERVICE "line-cua-mcp-dbkey"
#define MAX_FILES 64
#define MAX_FILE_BYTES (2LL << 30)
#define MAX_LIST 50000

static int out_fd = -1;
static char out_real[PATH_MAX];
static char home[PATH_MAX];

// ---- result.json --------------------------------------------------------

typedef struct { char *p; size_t n, cap; } buf;

static void put(buf *b, const char *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    b->cap = (b->n + n + 1) * 2;
    b->p = realloc(b->p, b->cap);
    if (!b->p) abort();
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
}

static void putraw(buf *b, const char *s) { put(b, s, strlen(s)); }

static void putf(buf *b, const char *fmt, ...) {
  char tmp[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  if (n > 0) put(b, tmp, (size_t)n < sizeof tmp ? (size_t)n : sizeof tmp - 1);
}

static void putstr(buf *b, const char *s) {
  putraw(b, "\"");
  for (const unsigned char *c = (const unsigned char *)s; *c; c++) {
    if (*c == '"' || *c == '\\') {
      char e[2] = {'\\', (char)*c};
      put(b, e, 2);
    } else if (*c < 0x20) {
      putf(b, "\\u%04x", *c);
    } else {
      put(b, (const char *)c, 1);
    }
  }
  putraw(b, "\"");
}

/** Write result.json atomically (tmp + rename): callers poll for it, because
 *  `open -W` cannot wait on a helper that already exited. */
static void write_result(buf *b) {
  int fd = openat(out_fd, "result.json.tmp", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) { perror("LINE Reader: result.json"); exit(2); }
  size_t off = 0;
  while (off < b->n) {
    ssize_t w = write(fd, b->p + off, b->n - off);
    if (w <= 0) { perror("LINE Reader: result.json"); exit(2); }
    off += (size_t)w;
  }
  close(fd);
  if (renameatx_np(out_fd, "result.json.tmp", out_fd, "result.json", RENAME_EXCL)) {
    perror("LINE Reader: result.json");
    exit(2);
  }
}

static void fail(const char *fmt, ...) {
  char msg[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  buf b = {0};
  putraw(&b, "{\"ok\":false,\"error\":");
  putstr(&b, msg);
  putraw(&b, "}\n");
  write_result(&b);
  exit(1);
}

// ---- paths --------------------------------------------------------------

/** Bind the caller's private output folder. Before this succeeds there is no
 *  safe place for result.json, so errors go to stderr (exit 2). */
static void open_out(const char *path) {
  struct stat st;
  if (lstat(path, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() || (st.st_mode & 077)) {
    fprintf(stderr, "LINE Reader: --out must be an existing folder you own with mode 0700\n");
    exit(2);
  }
  if (!realpath(path, out_real)) { perror("LINE Reader: --out"); exit(2); }
  out_fd = open(out_real, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (out_fd < 0 || fstat(out_fd, &st) || st.st_uid != getuid() || (st.st_mode & 077)) {
    fprintf(stderr, "LINE Reader: --out changed while opening it\n");
    exit(2);
  }
}

static int under(const char *path, const char *root) {
  size_t n = strlen(root);
  return !strncmp(path, root, n) && path[n] == '/';
}

/** Resolve `path` and require it to sit inside LINE's data folder. */
static void resolve_in_data(const char *path, char *real, const char *data_real) {
  if (path[0] != '/') fail("not an absolute path: %s", path);
  if (!realpath(path, real)) fail("cannot open %s: %s", path, strerror(errno));
  if (!under(real, data_real)) fail("refusing a path outside LINE's data folder: %s", path);
}

/** Copy one regular file into the output folder as `name`. Returns bytes. */
static long long copy_into(const char *src, const char *name) {
  int in = open(src, O_RDONLY | O_NOFOLLOW);
  if (in < 0) return -1;
  struct stat st;
  if (fstat(in, &st) || !S_ISREG(st.st_mode) || st.st_size > MAX_FILE_BYTES) {
    close(in);
    errno = EINVAL;
    return -1;
  }
  int out = openat(out_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (out < 0) { close(in); return -1; }
  static char chunk[1 << 16];
  long long total = 0;
  ssize_t r;
  while ((r = read(in, chunk, sizeof chunk)) > 0) {
    for (ssize_t off = 0; off < r;) {
      ssize_t w = write(out, chunk + off, (size_t)(r - off));
      if (w <= 0) { close(in); close(out); return -1; }
      off += w;
    }
    total += r;
  }
  close(in);
  close(out);
  return r < 0 ? -1 : total;
}

// ---- DB key -------------------------------------------------------------

/** Read the 32-hex DB key from the login keychain with Apple's `security`
 *  tool, which the item's access list already trusts (no extra prompt). */
static int read_key(char *key, size_t cap, char *err, size_t errcap) {
  size_t n = 0;
#ifdef LINE_READER_TEST
  const char *k = getenv("LINE_READER_TEST_KEY");
  if (!k) { snprintf(err, errcap, "key not found in keychain"); return -1; }
  n = strlcpy(key, k, cap);
#else
  int p[2];
  if (pipe(p)) { snprintf(err, errcap, "pipe: %s", strerror(errno)); return -1; }
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, p[1], 1);
  posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
  posix_spawn_file_actions_addclose(&fa, p[0]);
  posix_spawn_file_actions_addclose(&fa, p[1]);
  char home_env[PATH_MAX + 8];
  snprintf(home_env, sizeof home_env, "HOME=%s", home);
  char *argv[] = {"security", "find-generic-password", "-s", KEY_SERVICE, "-w", NULL};
  char *envp[] = {"PATH=/usr/bin:/bin", home_env, NULL};
  pid_t pid;
  int rc = posix_spawn(&pid, "/usr/bin/security", &fa, NULL, argv, envp);
  posix_spawn_file_actions_destroy(&fa);
  close(p[1]);
  if (rc) { close(p[0]); snprintf(err, errcap, "cannot run security: %s", strerror(rc)); return -1; }
  ssize_t r;
  while (n < cap - 1 && (r = read(p[0], key + n, cap - 1 - n)) > 0) n += (size_t)r;
  close(p[0]);
  int status = 0;
  waitpid(pid, &status, 0);
  key[n] = 0;
  if (!WIFEXITED(status) || WEXITSTATUS(status)) {
    snprintf(err, errcap, "key not found in keychain service '%s'", KEY_SERVICE);
    return -1;
  }
#endif
  while (n && (key[n - 1] == '\n' || key[n - 1] == '\r' || key[n - 1] == ' ')) key[--n] = 0;
  if (n != 32 || strspn(key, "0123456789abcdefABCDEF") != 32) {
    snprintf(err, errcap, "keychain value is not a 32-hex key");
    return -1;
  }
  return 0;
}

/** Hand the key to the caller through a FIFO it created inside --out and is
 *  already reading, so the key never lands in a regular file. */
static void send_key(const char *fifo, const char *key) {
  struct stat st;
  char parent[PATH_MAX], dir[PATH_MAX];
  if (strlcpy(dir, fifo, sizeof dir) >= sizeof dir) fail("--key-fifo path too long");
  char *slash = strrchr(dir, '/');
  if (!slash) fail("--key-fifo must be an absolute path");
  *slash = 0;
  if (!realpath(dir[0] ? dir : "/", parent) || strcmp(parent, out_real))
    fail("--key-fifo must be inside --out");
  if (lstat(fifo, &st) || !S_ISFIFO(st.st_mode) || st.st_uid != getuid())
    fail("--key-fifo is not a FIFO you own");
  int fd = open(fifo, O_WRONLY | O_NONBLOCK | O_NOFOLLOW);
  if (fd < 0) fail("--key-fifo has no reader: %s", strerror(errno));
  char line[40];
  int n = snprintf(line, sizeof line, "%s\n", key);
  ssize_t w = write(fd, line, (size_t)n);
  memset(line, 0, sizeof line);
  close(fd);
  if (w != n) fail("could not write the key to --key-fifo");
}

// ---- commands -----------------------------------------------------------

static int is_edb(const char *n) {
  size_t l = strlen(n);
  return l > 7 && !strncmp(n, "qwb", 3) && !strcmp(n + l - 4, ".edb");
}

/** Same choice as linedb.py always made: the first qwb*.edb (sorted) without
 *  "_" (skips keep_/album_/chatStats_ siblings); else the largest qwb*.edb. */
static int find_db(const char *db_dir, char *name, size_t cap) {
  DIR *d = opendir(db_dir);
  if (!d) return -1;
  errno = 0;
  char best[NAME_MAX + 1] = "", largest[NAME_MAX + 1] = "";
  off_t largest_size = -1;
  struct dirent *e;
  while ((e = readdir(d))) {
    if (!is_edb(e->d_name)) continue;
    if (!strchr(e->d_name, '_') && (!best[0] || strcmp(e->d_name, best) < 0))
      strlcpy(best, e->d_name, sizeof best);
    char p[PATH_MAX];
    struct stat st;
    snprintf(p, sizeof p, "%s/%s", db_dir, e->d_name);
    if (!lstat(p, &st) && S_ISREG(st.st_mode) && st.st_size > largest_size) {
      largest_size = st.st_size;
      strlcpy(largest, e->d_name, sizeof largest);
    }
  }
  closedir(d);
  const char *pick = best[0] ? best : largest;
  if (!pick[0]) { errno = ENOENT; return -1; }
  strlcpy(name, pick, cap);
  return 0;
}

static void cmd_snapshot(const char *fifo) {
  char db_dir[PATH_MAX], name[NAME_MAX + 1], src[PATH_MAX];
  snprintf(db_dir, sizeof db_dir, "%s%s", home, DB_REL);
  if (find_db(db_dir, name, sizeof name))
    fail("cannot find LINE's message DB in %s: %s", db_dir,
         errno == ENOENT ? "no qwb*.edb file" : strerror(errno));
  static const char *ext[] = {"", "-wal", "-shm"};
  long long size = 0;
  for (int i = 0; i < 3; i++) {
    char dst[32];
    snprintf(src, sizeof src, "%s/%s%s", db_dir, name, ext[i]);
    snprintf(dst, sizeof dst, "m.edb%s", ext[i]);
    long long n = copy_into(src, dst);
    if (n < 0 && !(i > 0 && errno == ENOENT)) fail("cannot copy %s%s: %s", name, ext[i], strerror(errno));
    if (i == 0) size = n;
  }
  char key[128] = "", err[256] = "";
  int key_ok = fifo ? read_key(key, sizeof key, err, sizeof err) == 0 : 0;
  if (key_ok) send_key(fifo, key);
  memset(key, 0, sizeof key);

  buf b = {0};
  putraw(&b, "{\"ok\":true,\"db\":\"m.edb\",\"source\":");
  snprintf(src, sizeof src, "%s/%s", db_dir, name);
  putstr(&b, src);
  putf(&b, ",\"bytes\":%lld,\"keySent\":%s", size, key_ok ? "true" : "false");
  if (fifo && !key_ok) { putraw(&b, ",\"keyError\":"); putstr(&b, err); }
  putraw(&b, "}\n");
  write_result(&b);
}

static void cmd_copy(int argc, char **argv, const char *data_real) {
  if (argc < 1) fail("copy needs at least one file");
  if (argc > MAX_FILES) fail("copy takes at most %d files", MAX_FILES);
  buf b = {0};
  putraw(&b, "{\"ok\":true,\"files\":[");
  for (int i = 0; i < argc; i++) {
    char real[PATH_MAX], dst[16];
    resolve_in_data(argv[i], real, data_real);
    snprintf(dst, sizeof dst, "f%d", i);
    long long n = copy_into(real, dst);
    if (n < 0) fail("cannot copy %s: %s", argv[i], strerror(errno));
    putraw(&b, i ? ",{\"path\":" : "{\"path\":");
    putstr(&b, argv[i]);
    putf(&b, ",\"copy\":\"%s\",\"bytes\":%lld}", dst, n);
  }
  putraw(&b, "]}\n");
  write_result(&b);
}

static void cmd_list(const char *folder, const char *data_real) {
  char real[PATH_MAX];
  if (folder[0] != '/' || !realpath(folder, real)) fail("cannot open %s", folder);
  if (strcmp(real, data_real) && !under(real, data_real))
    fail("refusing a path outside LINE's data folder: %s", folder);
  char *roots[] = {real, NULL};
  FTS *f = fts_open(roots, FTS_PHYSICAL | FTS_NOCHDIR, NULL);
  if (!f) fail("cannot list %s: %s", folder, strerror(errno));
  buf b = {0};
  putraw(&b, "{\"ok\":true,\"root\":");
  putstr(&b, real);
  putraw(&b, ",\"files\":[");
  int count = 0, truncated = 0;
  FTSENT *e;
  while ((e = fts_read(f))) {
    if (e->fts_info != FTS_F) continue;
    if (count == MAX_LIST) { truncated = 1; break; }
    putraw(&b, count++ ? ",{\"path\":" : "{\"path\":");
    putstr(&b, e->fts_path + strlen(real) + 1);
    putf(&b, ",\"bytes\":%lld,\"mtime\":%ld}", (long long)e->fts_statp->st_size, (long)e->fts_statp->st_mtime);
  }
  fts_close(f);
  putf(&b, "],\"truncated\":%s}\n", truncated ? "true" : "false");
  write_result(&b);
}

int main(int argc, char **argv) {
  const char *cmd = argc > 1 ? argv[1] : "";
  const char *out = NULL, *fifo = NULL;
  char *rest[MAX_FILES + 2];
  int nrest = 0;
  for (int i = 2; i < argc; i++) {
    if (!strcmp(argv[i], "--out") && i + 1 < argc) out = argv[++i];
    else if (!strcmp(argv[i], "--key-fifo") && i + 1 < argc) fifo = argv[++i];
    else if (!strncmp(argv[i], "-psn_", 5)) continue;  // legacy LaunchServices arg
    else if (nrest < MAX_FILES + 1) rest[nrest++] = argv[i];
    else nrest = MAX_FILES + 1;
  }
  if (!out) {
    fprintf(stderr, "usage: line-reader snapshot|copy|list --out DIR ...\n");
    return 2;
  }
#ifdef LINE_READER_TEST
  const char *h = getenv("LINE_READER_TEST_HOME");
#else
  struct passwd *pw = getpwuid(getuid());
  const char *h = pw ? pw->pw_dir : NULL;
#endif
  if (!h || strlcpy(home, h, sizeof home) >= sizeof home) {
    fprintf(stderr, "LINE Reader: cannot find your home folder\n");
    return 2;
  }
  open_out(out);

  char data[PATH_MAX], data_real[PATH_MAX];
  snprintf(data, sizeof data, "%s%s", home, DATA_REL);
  if (!strcmp(cmd, "snapshot") && nrest == 0) cmd_snapshot(fifo);
  else if (!strcmp(cmd, "copy") || (!strcmp(cmd, "list") && nrest == 1)) {
    if (!realpath(data, data_real)) fail("LINE data folder not found: %s", data);
    if (!strcmp(cmd, "copy")) cmd_copy(nrest, rest, data_real);
    else cmd_list(rest[0], data_real);
  } else fail("unknown command or arguments: %s", cmd);
  return 0;
}

#define _GNU_SOURCE
#include <curl/curl.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#ifndef __APPLE__
#include <sys/wait.h>
#endif
#include <moonbit.h>
#ifdef __APPLE__
#include <ifaddrs.h>
#include <mach/host_info.h>
#include <mach/mach_host.h>
#include <mach/mach_port.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <sys/sysctl.h>
#endif

static char *to_c_string(moonbit_bytes_t bytes) {
  int32_t n = Moonbit_array_length(bytes);
  char *s = malloc((size_t)n + 1);
  if (!s) return NULL;
  memcpy(s, bytes, (size_t)n);
  s[n] = '\0';
  return s;
}

static moonbit_string_t from_ascii(const char *s) {
  size_t n = strlen(s);
  moonbit_string_t out = moonbit_make_string_raw((int32_t)n);
  for (size_t i = 0; i < n; ++i) out[i] = (unsigned char)s[i];
  return out;
}

struct response_buffer {
  char data[4096];
  size_t len;
};

static size_t capture_body(char *ptr, size_t size, size_t nmemb, void *userdata) {
  size_t total = size * nmemb;
  struct response_buffer *buf = (struct response_buffer *)userdata;
  if (buf && buf->len + 1 < sizeof(buf->data)) {
    size_t copy = total;
    if (buf->len + copy >= sizeof(buf->data)) {
      copy = sizeof(buf->data) - buf->len - 1;
    }
    memcpy(buf->data + buf->len, ptr, copy);
    buf->len += copy;
    buf->data[buf->len] = '\0';
  }
  return total;
}

static int create_parent_dirs(char *path) {
  for (char *p = path + 1; *p; ++p) {
    if (*p != '/') continue;
    *p = '\0';
    if (mkdir(path, 0700) != 0 && errno != EEXIST) { *p = '/'; return 0; }
    struct stat st;
    if (lstat(path, &st) != 0 || !S_ISDIR(st.st_mode)) { *p = '/'; return 0; }
    *p = '/';
  }
  return 1;
}

#define MAX_PROC 65536
moonbit_string_t cfmon_read_file(moonbit_bytes_t path) {
  char *cpath = to_c_string(path);
  FILE *f = cpath ? fopen(cpath, "r") : NULL;
  free(cpath);
  moonbit_decref(path);
  if (!f) return from_ascii("");
  char buf[MAX_PROC + 1];
  size_t n = fread(buf, 1, MAX_PROC, f);
  fclose(f);
  buf[n] = 0;
  return from_ascii(buf);
}

moonbit_string_t cfmon_getenv(moonbit_bytes_t key) {
  char *ckey = to_c_string(key);
  const char *v = ckey ? getenv(ckey) : NULL;
  char copy[4096];
  snprintf(copy, sizeof(copy), "%s", v ? v : "");
  free(ckey);
  moonbit_decref(key);
  return from_ascii(copy);
}

moonbit_string_t cfmon_hostname(void) {
  char buf[256] = {0};
  if (gethostname(buf, sizeof(buf) - 1) != 0) strcpy(buf, "unknown");
  return from_ascii(buf);
}

moonbit_string_t cfmon_os_name(void) {
#ifdef __APPLE__
  return from_ascii("macos");
#else
  return from_ascii("linux");
#endif
}

#ifdef __APPLE__
double cfmon_disk_used(void);
moonbit_string_t cfmon_macos_metrics(void) {
  static uint64_t previous_total = 0, previous_busy = 0;
  static int have_previous_cpu = 0;
  host_cpu_load_info_data_t cpu;
  host_t host = mach_host_self();
  mach_msg_type_number_t cpu_count = HOST_CPU_LOAD_INFO_COUNT;
  double cpu_used = 0.0, memory_used = 0.0, load = 0.0, uptime = 0.0;
  uint64_t rx = 0, tx = 0, total_memory = 0;
  if (host_statistics(host, HOST_CPU_LOAD_INFO, (host_info_t)&cpu, &cpu_count) == KERN_SUCCESS) {
    uint64_t user = cpu.cpu_ticks[CPU_STATE_USER];
    uint64_t system = cpu.cpu_ticks[CPU_STATE_SYSTEM];
    uint64_t nice = cpu.cpu_ticks[CPU_STATE_NICE];
    uint64_t idle = cpu.cpu_ticks[CPU_STATE_IDLE];
    uint64_t total = user + system + nice + idle;
    uint64_t busy = total - idle;
    if (have_previous_cpu && total > previous_total)
      cpu_used = (double)(busy - previous_busy) / (double)(total - previous_total);
    previous_total = total;
    previous_busy = busy;
    have_previous_cpu = 1;
  }
  vm_statistics64_data_t vm;
  mach_msg_type_number_t vm_count = HOST_VM_INFO64_COUNT;
  if (host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&vm, &vm_count) == KERN_SUCCESS &&
      sysctlbyname("hw.memsize", &total_memory, &(size_t){sizeof(total_memory)}, NULL, 0) == 0 && total_memory > 0) {
    uint64_t available = (uint64_t)(vm.free_count + vm.inactive_count + vm.speculative_count + vm.purgeable_count) * sysconf(_SC_PAGESIZE);
    memory_used = 1.0 - (double)available / (double)total_memory;
  }
  double loads[1];
  if (getloadavg(loads, 1) == 1) load = loads[0];
  struct ifaddrs *interfaces = NULL;
  if (getifaddrs(&interfaces) == 0) {
    for (struct ifaddrs *it = interfaces; it; it = it->ifa_next) {
      if (!it->ifa_addr || it->ifa_addr->sa_family != AF_LINK || strcmp(it->ifa_name, "lo0") == 0 || !it->ifa_data) continue;
      struct if_data *data = (struct if_data *)it->ifa_data;
      rx += data->ifi_ibytes;
      tx += data->ifi_obytes;
    }
    freeifaddrs(interfaces);
  }
  struct timeval boot;
  size_t boot_size = sizeof(boot);
  if (sysctlbyname("kern.boottime", &boot, &boot_size, NULL, 0) == 0)
    uptime = (double)time(NULL) - (double)boot.tv_sec;
  mach_port_deallocate(mach_task_self(), host);
  if (cpu_used < 0.0) cpu_used = 0.0;
  if (cpu_used > 1.0) cpu_used = 1.0;
  if (memory_used < 0.0) memory_used = 0.0;
  if (memory_used > 1.0) memory_used = 1.0;
  char result[256];
  snprintf(result, sizeof(result), "%.10g,%.10g,%.10g,%.10g,%llu,%llu,%.10g",
    cpu_used, memory_used, load, cfmon_disk_used(),
    (unsigned long long)rx, (unsigned long long)tx, uptime);
  return from_ascii(result);
}
#else
moonbit_string_t cfmon_macos_metrics(void) { return from_ascii(""); }
#endif

moonbit_string_t cfmon_nvidia_metrics(void) {
#ifdef __APPLE__
  return from_ascii("");
#else
  FILE *pipe = popen("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null", "r");
  if (!pipe) return from_ascii("");
  char result[256] = "";
  if (fgets(result, sizeof(result), pipe)) {
    char *newline = strchr(result, '\n');
    if (newline) *newline = '\0';
  }
  int status = pclose(pipe);
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return from_ascii("");
  return from_ascii(result);
#endif
}

double cfmon_monotonic(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

int cfmon_sleep(int seconds) { return sleep(seconds); }

double cfmon_disk_used(void) {
  struct statvfs s;
  if (statvfs("/", &s) != 0 || s.f_blocks == 0) return 0.0;
  return 1.0 - (double)s.f_bavail / (double)s.f_blocks;
}

static int make_state_dir(const char *override, char *out, size_t cap) {
  const char *home = getenv("HOME");
  if (override && *override) {
    if (override[0] != '/') return 0;
    if (snprintf(out, cap, "%s", override) >= (int)cap) return 0;
  } else if (getenv("XDG_STATE_HOME") && getenv("XDG_STATE_HOME")[0] == '/') {
    if (snprintf(out, cap, "%s/cfmon", getenv("XDG_STATE_HOME")) >= (int)cap) return 0;
  } else {
    if (!home || home[0] != '/' || snprintf(out, cap, "%s/.local/state/cfmon", home) >= (int)cap) return 0;
  }
  if (!create_parent_dirs(out)) return 0;
  if (mkdir(out, 0700) != 0 && errno != EEXIST) return 0;
  struct stat st;
  if (lstat(out, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != geteuid()) return 0;
  if ((st.st_mode & 077) != 0 && chmod(out, 0700) != 0) return 0;
  if (lstat(out, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 077) != 0) return 0;
  return 1;
}

static int state_file_path(const char *state_arg, const char *filename, char *dir, size_t cap, char *path, size_t path_cap) {
  if (!make_state_dir(state_arg, dir, cap)) return 0;
  if (snprintf(path, path_cap, "%s/%s", dir, filename) >= (int)path_cap) return 0;
  return 1;
}

static int load_or_create_token(const char *state_arg, unsigned char token[32]) {
  char dir[PATH_MAX], path[PATH_MAX];
  if (!state_file_path(state_arg, "agent.token", dir, sizeof(dir), path, sizeof(path))) return 0;
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 && errno == ENOENT) {
    if (RAND_bytes(token, 32) != 1) return 0;
    char temp_path[PATH_MAX];
    if (snprintf(temp_path, sizeof(temp_path), "%s.tmp.XXXXXX", path) >= (int)sizeof(temp_path)) {
      OPENSSL_cleanse(token, 32); return 0;
    }
    fd = mkstemp(temp_path);
    if (fd < 0) { OPENSSL_cleanse(token, 32); return 0; }
    (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
    size_t off = 0;
    while (off < 32) {
      ssize_t n = write(fd, token + off, 32 - off);
      if (n <= 0) { close(fd); unlink(temp_path); OPENSSL_cleanse(token, 32); return 0; }
      off += (size_t)n;
    }
    int write_ok = fsync(fd) == 0 && fchmod(fd, 0600) == 0;
    if (close(fd) != 0) write_ok = 0;
    if (!write_ok) { unlink(temp_path); OPENSSL_cleanse(token, 32); return 0; }
    if (link(temp_path, path) != 0) {
      int existed = errno == EEXIST;
      unlink(temp_path); OPENSSL_cleanse(token, 32);
      return existed ? load_or_create_token(state_arg, token) : 0;
    }
    unlink(temp_path);
    return 1;
  }
  if (fd < 0) return 0;
  struct stat st;
  int ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == geteuid() && (st.st_mode & 0777) == 0600 && st.st_size == 32;
  size_t off = 0;
  while (ok && off < 32) {
    ssize_t n = read(fd, token + off, 32 - off);
    if (n <= 0) { ok = 0; break; }
    off += (size_t)n;
  }
  close(fd);
  if (!ok) OPENSSL_cleanse(token, 32);
  return ok;
}

static int valid_header_value(const char *s) {
  if (!s || !*s) return 0;
  size_t len = 0;
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
    if (*p < 0x20 || *p == 0x7f) return 0;
    if (++len > 256) return 0;
  }
  return 1;
}

static int save_service_token(const char *state_arg, const char *client_id, const char *client_secret) {
  if (!valid_header_value(client_id) || !valid_header_value(client_secret)) return 0;
  char dir[PATH_MAX], path[PATH_MAX], temp_path[PATH_MAX];
  if (!state_file_path(state_arg, "service.token", dir, sizeof(dir), path, sizeof(path))) return 0;
  if (snprintf(temp_path, sizeof(temp_path), "%s.tmp.XXXXXX", path) >= (int)sizeof(temp_path)) return 0;
  char content[600];
  int content_len = snprintf(content, sizeof(content), "%s\n%s\n", client_id, client_secret);
  if (content_len <= 0 || content_len >= (int)sizeof(content)) return 0;
  int fd = mkstemp(temp_path);
  if (fd < 0) return 0;
  (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
  size_t off = 0;
  while (off < (size_t)content_len) {
    ssize_t n = write(fd, content + off, (size_t)content_len - off);
    if (n <= 0) { close(fd); unlink(temp_path); OPENSSL_cleanse(content, sizeof(content)); return 0; }
    off += (size_t)n;
  }
  OPENSSL_cleanse(content, sizeof(content));
  int ok = fsync(fd) == 0 && fchmod(fd, 0600) == 0;
  if (close(fd) != 0) ok = 0;
  if (!ok || rename(temp_path, path) != 0) {
    unlink(temp_path);
    return 0;
  }
  return 1;
}

static int load_service_token(const char *state_arg, char *client_id, size_t id_cap, char *client_secret, size_t secret_cap) {
  char dir[PATH_MAX], path[PATH_MAX];
  if (!state_file_path(state_arg, "service.token", dir, sizeof(dir), path, sizeof(path))) return 0;
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  struct stat st;
  char buf[600];
  int ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == geteuid() &&
    (st.st_mode & 0777) == 0600 && st.st_size > 2 && st.st_size < (off_t)sizeof(buf);
  size_t off = 0;
  while (ok && off < (size_t)st.st_size) {
    ssize_t n = read(fd, buf + off, (size_t)st.st_size - off);
    if (n <= 0) { ok = 0; break; }
    off += (size_t)n;
  }
  close(fd);
  if (!ok) { OPENSSL_cleanse(buf, sizeof(buf)); return 0; }
  buf[off] = '\0';
  char *nl1 = strchr(buf, '\n');
  if (!nl1) { OPENSSL_cleanse(buf, sizeof(buf)); return 0; }
  *nl1 = '\0';
  char *secret_start = nl1 + 1;
  char *nl2 = strchr(secret_start, '\n');
  if (nl2) *nl2 = '\0';
  if (!valid_header_value(buf) || !valid_header_value(secret_start) ||
      snprintf(client_id, id_cap, "%s", buf) >= (int)id_cap ||
      snprintf(client_secret, secret_cap, "%s", secret_start) >= (int)secret_cap) {
    OPENSSL_cleanse(buf, sizeof(buf));
    return 0;
  }
  OPENSSL_cleanse(buf, sizeof(buf));
  return 1;
}

static int extract_json_string(const char *json, const char *key, char *out, size_t cap) {
  char pattern[64];
  if (snprintf(pattern, sizeof(pattern), "\"%s\"", key) >= (int)sizeof(pattern)) return 0;
  const char *p = strstr(json, pattern);
  if (!p) return 0;
  p += strlen(pattern);
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
  if (*p != ':') return 0;
  ++p;
  while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') ++p;
  if (*p != '"') return 0;
  ++p;
  size_t i = 0;
  while (*p && *p != '"') {
    if (*p == '\\') {
      ++p;
      if (!*p) return 0;
    }
    if ((unsigned char)*p < 0x20 || (unsigned char)*p == 0x7f || i + 1 >= cap) return 0;
    out[i++] = *p++;
  }
  if (*p != '"') return 0;
  out[i] = '\0';
  return i > 0;
}

static void hex(const unsigned char *in, size_t n, char *out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) { out[2*i] = digits[in[i] >> 4]; out[2*i+1] = digits[in[i] & 15]; }
  out[2*n] = 0;
}

moonbit_string_t cfmon_fingerprint(moonbit_bytes_t state_bytes) {
  char *state = to_c_string(state_bytes);
  unsigned char token[32], digest[SHA256_DIGEST_LENGTH];
  char result[65] = "";
  if (state && load_or_create_token(state, token)) {
    SHA256(token, sizeof(token), digest);
    hex(digest, sizeof(digest), result);
    OPENSSL_cleanse(token, sizeof(token));
  }
  free(state); moonbit_decref(state_bytes);
  return from_ascii(result);
}

int cfmon_signed_post(moonbit_bytes_t url_bytes, moonbit_bytes_t state_bytes, moonbit_bytes_t body_bytes) {
  char *url = to_c_string(url_bytes), *state = to_c_string(state_bytes), *body = to_c_string(body_bytes);
  int status = -1;
  unsigned char token[32];
  char token_hex[65] = "";
  char client_id[280] = "", client_secret[280] = "";
  if (!url || !state || !body || strlen(body) > 65536 || !load_or_create_token(state, token)) goto done;
  hex(token, sizeof(token), token_hex);
  const char *path = strstr(url, "://");
  path = path ? strchr(path + 3, '/') : NULL;
  if (!path || strchr(path, '?') || strchr(path, '#')) goto done;
  int is_pair = strcmp(path, "/api/v1/pair") == 0;
  int is_ingest = strcmp(path, "/api/v1/ingest") == 0;
  if (!is_pair && !is_ingest) goto done;
  if (is_ingest && !load_service_token(state, client_id, sizeof(client_id), client_secret, sizeof(client_secret))) {
    status = 401;
    goto done;
  }
  CURL *curl = curl_easy_init();
  if (!curl) goto done;
  struct curl_slist *headers = NULL;
  headers = curl_slist_append(headers, "Content-Type: application/json");
  char auth_header[128];
  snprintf(auth_header, sizeof(auth_header), "Authorization: Bearer %s", token_hex);
  headers = curl_slist_append(headers, auth_header);
  if (is_ingest) {
    char id_header[320], secret_header[320];
    snprintf(id_header, sizeof(id_header), "CF-Access-Client-Id: %s", client_id);
    snprintf(secret_header, sizeof(secret_header), "CF-Access-Client-Secret: %s", client_secret);
    headers = curl_slist_append(headers, id_header);
    headers = curl_slist_append(headers, secret_header);
    OPENSSL_cleanse(id_header, sizeof(id_header));
    OPENSSL_cleanse(secret_header, sizeof(secret_header));
  }
  struct response_buffer resp = {{0}, 0};
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, capture_body);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_NOPROXY, "localhost,127.0.0.1");
#if LIBCURL_VERSION_NUM >= 0x075500
  curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
#else
  curl_easy_setopt(curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTP | CURLPROTO_HTTPS);
#endif
  CURLcode result = curl_easy_perform(curl);
  long code = 0; curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
  if (result == CURLE_OK) {
    status = (int)code;
    if (is_pair && status == 200) {
      if (!extract_json_string(resp.data, "access_client_id", client_id, sizeof(client_id)) ||
          !extract_json_string(resp.data, "access_client_secret", client_secret, sizeof(client_secret)) ||
          !save_service_token(state, client_id, client_secret)) {
        status = -1;
      }
    }
  }
  OPENSSL_cleanse(&resp, sizeof(resp));
  curl_slist_free_all(headers); curl_easy_cleanup(curl);
 done:
  OPENSSL_cleanse(token, sizeof(token));
  OPENSSL_cleanse(token_hex, sizeof(token_hex));
  OPENSSL_cleanse(client_id, sizeof(client_id));
  OPENSSL_cleanse(client_secret, sizeof(client_secret));
  free(url); free(state); free(body);
  moonbit_decref(url_bytes); moonbit_decref(state_bytes); moonbit_decref(body_bytes);
  return status;
}

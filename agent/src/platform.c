#define _GNU_SOURCE
#include <curl/curl.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <openssl/evp.h>
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

static size_t discard_body(char *ptr, size_t size, size_t nmemb, void *userdata) {
  (void)ptr; (void)userdata;
  return size * nmemb;
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

static int key_path(const char *state_arg, char *dir, size_t cap, char *path, size_t path_cap) {
  if (!make_state_dir(state_arg, dir, cap)) return 0;
  if (snprintf(path, path_cap, "%s/agent.ed25519", dir) >= (int)path_cap) return 0;
  return 1;
}

static int load_or_create_key(const char *state_arg, unsigned char priv[32], unsigned char pub[32]) {
  char dir[PATH_MAX], path[PATH_MAX];
  if (!key_path(state_arg, dir, sizeof(dir), path, sizeof(path))) return 0;
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0 && errno == ENOENT) {
    EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, NULL);
    EVP_PKEY *key = NULL;
    size_t priv_len = 32, pub_len = 32;
    int ok = ctx && EVP_PKEY_keygen_init(ctx) > 0 && EVP_PKEY_keygen(ctx, &key) > 0 &&
      EVP_PKEY_get_raw_private_key(key, priv, &priv_len) > 0 && EVP_PKEY_get_raw_public_key(key, pub, &pub_len) > 0;
    EVP_PKEY_free(key); EVP_PKEY_CTX_free(ctx);
    if (!ok || priv_len != 32 || pub_len != 32) return 0;
    char temp_path[PATH_MAX];
    if (snprintf(temp_path, sizeof(temp_path), "%s.tmp.XXXXXX", path) >= (int)sizeof(temp_path)) {
      OPENSSL_cleanse(priv, 32); return 0;
    }
    fd = mkstemp(temp_path);
    if (fd < 0) { OPENSSL_cleanse(priv, 32); return 0; }
    (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
    size_t off = 0;
    while (off < 32) {
      ssize_t n = write(fd, priv + off, 32 - off);
      if (n <= 0) { close(fd); unlink(temp_path); OPENSSL_cleanse(priv, 32); return 0; }
      off += (size_t)n;
    }
    int write_ok = fsync(fd) == 0 && fchmod(fd, 0600) == 0;
    if (close(fd) != 0) write_ok = 0;
    if (!write_ok) { unlink(temp_path); OPENSSL_cleanse(priv, 32); return 0; }
    if (link(temp_path, path) != 0) {
      int existed = errno == EEXIST;
      unlink(temp_path); OPENSSL_cleanse(priv, 32);
      return existed ? load_or_create_key(state_arg, priv, pub) : 0;
    }
    unlink(temp_path);
    return 1;
  }
  if (fd < 0) return 0;
  struct stat st;
  int ok = fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == geteuid() && (st.st_mode & 0777) == 0600 && st.st_size == 32;
  size_t off = 0;
  while (ok && off < 32) {
    ssize_t n = read(fd, priv + off, 32 - off);
    if (n <= 0) { ok = 0; break; }
    off += (size_t)n;
  }
  close(fd);
  if (!ok) { OPENSSL_cleanse(priv, 32); return 0; }
  EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, priv, 32);
  size_t pub_len = 32;
  ok = key && EVP_PKEY_get_raw_public_key(key, pub, &pub_len) > 0 && pub_len == 32;
  EVP_PKEY_free(key);
  if (!ok) OPENSSL_cleanse(priv, 32);
  return ok;
}

static void hex(const unsigned char *in, size_t n, char *out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) { out[2*i] = digits[in[i] >> 4]; out[2*i+1] = digits[in[i] & 15]; }
  out[2*n] = 0;
}

moonbit_string_t cfmon_fingerprint(moonbit_bytes_t state_bytes) {
  char *state = to_c_string(state_bytes);
  unsigned char priv[32], pub[32], digest[SHA256_DIGEST_LENGTH];
  char result[65] = "";
  if (state && load_or_create_key(state, priv, pub)) {
    SHA256(pub, sizeof(pub), digest);
    hex(digest, sizeof(digest), result);
    OPENSSL_cleanse(priv, sizeof(priv));
  }
  free(state); moonbit_decref(state_bytes);
  return from_ascii(result);
}

int cfmon_signed_post(moonbit_bytes_t url_bytes, moonbit_bytes_t state_bytes, moonbit_bytes_t body_bytes) {
  char *url = to_c_string(url_bytes), *state = to_c_string(state_bytes), *body = to_c_string(body_bytes);
  int status = -1;
  unsigned char priv[32], pub[32], nonce[16], sig[64];
  if (!url || !state || !body || strlen(body) > 65536 || !load_or_create_key(state, priv, pub) || RAND_bytes(nonce, sizeof(nonce)) != 1) goto done;
  char pubhex[65], noncehex[33], sighex[129], ts[32];
  hex(pub, 32, pubhex); hex(nonce, 16, noncehex);
  snprintf(ts, sizeof(ts), "%lld", (long long)time(NULL));
  const char *path = strstr(url, "://");
  path = path ? strchr(path + 3, '/') : NULL;
  if (!path || strchr(path, '?') || strchr(path, '#') ||
      (strcmp(path, "/api/v1/pair") != 0 && strcmp(path, "/api/v1/ingest") != 0)) goto done;
  size_t signed_len = 5 + strlen(path) + 1 + strlen(ts) + 1 + strlen(noncehex) + 1 + strlen(body);
  char *signed_data = malloc(signed_len + 1);
  if (!signed_data) goto done;
  snprintf(signed_data, signed_len + 1, "POST\n%s\n%s\n%s\n%s", path, ts, noncehex, body);
  EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, priv, sizeof(priv));
  EVP_MD_CTX *md = EVP_MD_CTX_new(); size_t sig_len = sizeof(sig);
  int ok = key && md && EVP_DigestSignInit(md, NULL, NULL, NULL, key) > 0 && EVP_DigestSign(md, sig, &sig_len, (unsigned char *)signed_data, signed_len) > 0 && sig_len == 64;
  EVP_MD_CTX_free(md); EVP_PKEY_free(key); OPENSSL_cleanse(signed_data, signed_len); free(signed_data);
  if (!ok) goto done;
  hex(sig, 64, sighex);
  CURL *curl = curl_easy_init();
  if (!curl) goto done;
  struct curl_slist *headers = NULL;
  headers = curl_slist_append(headers, "Content-Type: application/json");
  char header[256];
  snprintf(header, sizeof(header), "X-Cfmon-Key: %s", pubhex); headers = curl_slist_append(headers, header);
  snprintf(header, sizeof(header), "X-Cfmon-Timestamp: %s", ts); headers = curl_slist_append(headers, header);
  snprintf(header, sizeof(header), "X-Cfmon-Nonce: %s", noncehex); headers = curl_slist_append(headers, header);
  snprintf(header, sizeof(header), "X-Cfmon-Signature: %s", sighex); headers = curl_slist_append(headers, header);
  curl_easy_setopt(curl, CURLOPT_URL, url);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(body));
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discard_body);
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
  if (result == CURLE_OK) status = (int)code;
  curl_slist_free_all(headers); curl_easy_cleanup(curl);
 done:
  OPENSSL_cleanse(priv, sizeof(priv));
  free(url); free(state); free(body);
  moonbit_decref(url_bytes); moonbit_decref(state_bytes); moonbit_decref(body_bytes);
  return status;
}

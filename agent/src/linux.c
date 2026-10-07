#define _GNU_SOURCE
#include <curl/curl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>
#include <moonbit.h>

static char *to_c_string(moonbit_bytes_t bytes) {
  int32_t n = Moonbit_array_length(bytes);
  char *s = malloc((size_t)n + 1);
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
  return size * nmemb;
}

#define MAX_PROC 65536
moonbit_string_t cfmon_read_file(moonbit_bytes_t path) {
  char *cpath = to_c_string(path);
  FILE *f = fopen(cpath, "r");
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
  const char *v = getenv(ckey);
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

int cfmon_post(moonbit_bytes_t url, moonbit_bytes_t token, moonbit_bytes_t body) {
  char *curl_url = to_c_string(url), *curl_token = to_c_string(token), *curl_body = to_c_string(body);
  CURL *curl = curl_easy_init();
  if (!curl) { free(curl_url); free(curl_token); free(curl_body); moonbit_decref(url); moonbit_decref(token); moonbit_decref(body); return 0; }
  struct curl_slist *headers = NULL;
  headers = curl_slist_append(headers, "Content-Type: application/json");
  char auth[4096];
  if (strchr(curl_token, '\r') || strchr(curl_token, '\n') || strlen(curl_token) > 4000) {
    curl_slist_free_all(headers); curl_easy_cleanup(curl); free(curl_url); free(curl_token); free(curl_body);
    moonbit_decref(url); moonbit_decref(token); moonbit_decref(body); return 0;
  }
  snprintf(auth, sizeof(auth), "Authorization: Bearer %s", curl_token);
  headers = curl_slist_append(headers, auth);
  curl_easy_setopt(curl, CURLOPT_URL, curl_url);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDS, curl_body);
  curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(curl_body));
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discard_body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_NOPROXY, "localhost,127.0.0.1");
  curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
  CURLcode result = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  free(curl_url); free(curl_token); free(curl_body);
  moonbit_decref(url); moonbit_decref(token); moonbit_decref(body);
  return result == CURLE_OK && status >= 200 && status < 300;
}

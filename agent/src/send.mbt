///|
fn valid_host(host : String) -> Bool {
  if host.length() == 0 || host.length() > 128 {
    return false
  }
  for i = 0; i < host.length(); i = i + 1 {
    let c = host[i].to_int()
    let valid = (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c == 45 ||
      c == 46 ||
      c == 95
    if !valid ||
      (
        i == 0 &&
        !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57))
      ) {
      return false
    }
  }
  true
}

///|
fn has_newline(s : String) -> Bool {
  s.contains("\n") || s.contains("\r")
}

///|
fn split_to_array(s : String, separator : String) -> Array[String] {
  let out : Array[String] = []
  for part in s.split(separator) {
    out.push(part.to_owned())
  }
  out
}

///|
fn valid_url(url : String, endpoint : String) -> Bool {
  let scheme_parts = split_to_array(url, "://")
  if scheme_parts.length() != 2 {
    return false
  }
  let scheme = scheme_parts[0]
  if scheme != "https" && scheme != "http" {
    return false
  }
  let path_parts = split_to_array(scheme_parts[1], "/")
  if path_parts.length() != 4 ||
    path_parts[1] != "api" ||
    path_parts[2] != "v1" ||
    path_parts[3] != endpoint {
    return false
  }
  let authority = path_parts[0]
  if authority == "" || authority.contains("@") || authority.contains(" ") ||
    authority.contains("?") || authority.contains("#") {
    return false
  }
  let host_port = split_to_array(authority, ":")
  if host_port.length() > 2 || host_port[0] == "" {
    return false
  }
  for i = 0; i < host_port[0].length(); i = i + 1 {
    let c = host_port[0][i].to_int()
    if !((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c == 45 || c == 46) {
      return false
    }
  }
  if host_port.length() == 2 {
    if host_port[1] == "" { return false }
    for i = 0; i < host_port[1].length(); i = i + 1 {
      let c = host_port[1][i].to_int()
      if c < 48 || c > 57 { return false }
    }
    let port = @string.parse_int(host_port[1].view()) catch { _ => 0 }
    if port < 1 || port > 65535 { return false }
  }
  if scheme == "http" {
    if host_port.length() != 2 ||
      (host_port[0] != "localhost" && host_port[0] != "127.0.0.1") {
      return false
    }
    return true
  }
  true
}

///|
fn state_dir() -> String {
  env("CFMON_STATE_DIR")
}

///|
fn send_payload(payload : MetricPayload, url : String, dir : String) -> Int {
  signed_post(@utf8.encode(url), @utf8.encode(dir), @utf8.encode(payload.json()))
}

///|
fn pair_body(host : String) -> String {
  "{\"host\":\"\{host}\",\"os\":\"linux\"}"
}

///|
fn ensure_paired(pair_url : String, dir : String, host : String, once : Bool) -> Bool {
  let fp = fingerprint(@utf8.encode(dir))
  if fp == "" {
    eprintln("unable to create or read the private key in cfmon state directory")
    process_exit(2)
  }
  eprintln("cfmon key fingerprint: \{fp}")
  eprintln("Dashboardでこのfingerprintを確認して承認してください")
  let body = pair_body(host)
  while true {
    let status = signed_post(@utf8.encode(pair_url), @utf8.encode(dir), @utf8.encode(body))
    if status == 200 {
      return true
    }
    if status == 403 {
      eprintln("pairing was rejected (the key may be revoked); check Dashboard status")
      process_exit(2)
    }
    if status != 202 {
      eprintln("failed to check cfmon pairing status (HTTP \{status})")
      if once {
        process_exit(1)
      }
    }
    if once {
      eprintln("pairing is pending; approve the fingerprint, then run again")
      process_exit(2)
    }
    ignore(sleep_seconds(10))
  }
  false
}

///|
fn run_agent() -> Unit {
  let argv = @env.args()
  let once = argv.contains("--once")
  let print_only = argv.contains("--print")
  let interval_raw = env("CFMON_INTERVAL_SECONDS")
  let interval = if interval_raw == "" {
    30
  } else {
    @string.parse_int(interval_raw.view()) catch {
      _ => 0
    }
  }
  if interval < 1 {
    eprintln("CFMON_INTERVAL_SECONDS must be a positive integer")
    process_exit(2)
  }
  let url = env("CFMON_URL")
  if !print_only && (!valid_url(url, "ingest") || has_newline(url)) {
    eprintln("invalid CFMON_URL; use https://.../api/v1/ingest or loopback HTTP with a port")
    process_exit(2)
  }
  let mut previous_cpu = current_cpu()
  let mut previous_net = current_network()
  let mut previous_time = monotonic()
  let mut sent = false
  let dir = state_dir()
  let pair_url = url.replace(old="/api/v1/ingest", new="/api/v1/pair")
  let mut paired = false
  while !once || !sent {
    if !print_only && !paired {
      let host = env("CFMON_HOST")
      let pair_host = if host == "" { hostname() } else { host }
      if !valid_host(pair_host) {
        eprintln("hostname must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}")
        process_exit(2)
      }
      paired = ensure_paired(pair_url, dir, pair_host, once)
    }
    if !once && sent {
      ignore(sleep_seconds(interval))
    }
    if !sent {
      ignore(sleep_seconds(1))
    }
    let now = monotonic()
    let payload = collect(previous_cpu, previous_net, now - previous_time)
    if !valid_host(payload.host) {
      eprintln("hostname must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}")
      process_exit(2)
    }
    if print_only {
      println(payload.json())
      process_exit(0)
    }
    let status = send_payload(payload, url, dir)
    if status == 403 {
      eprintln("metric request was rejected; check Dashboard approval status")
      process_exit(2)
    }
    if status < 200 || status >= 300 {
      eprintln("failed to send metrics (HTTP \{status})")
      if once { process_exit(1) }
    }
    sent = true
    previous_cpu = current_cpu()
    previous_net = current_network()
    previous_time = monotonic()
  }
}

///|
test "host ids and HTTP destinations are constrained" {
  assert_true(valid_host("bronya.example-1"))
  assert_false(valid_host("host\""))
  assert_false(valid_host("-bronya"))
  assert_true(valid_url("https://cfmon.example.com/api/v1/ingest", "ingest"))
  assert_true(valid_url("http://127.0.0.1:8787/api/v1/ingest", "ingest"))
  assert_false(valid_url("http://localhost.evil.com/api/v1/ingest", "ingest"))
  assert_false(valid_url("http://localhost:80@evil.com/api/v1/ingest", "ingest"))
  assert_false(valid_url("http://localhost/api/v1/ingest", "ingest"))
  assert_false(valid_url("http://example.com/api/v1/ingest", "ingest"))
}

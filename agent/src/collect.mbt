///|
fn fields(line : String) -> Array[String] {
  let out : Array[String] = []
  for part in line.trim().split(" ") {
    let s = part.to_owned()
    if s != "" {
      out.push(s)
    }
  }
  out
}

///|
fn number(s : String) -> Double {
  @string.parse_double(s) catch {
    _ => 0.0
  }
}

///|
fn clamp(value : Double, low : Double, high : Double) -> Double {
  if value < low {
    low
  } else if value > high {
    high
  } else {
    value
  }
}

///|
fn nonnegative(value : Double) -> Double {
  if value < 0.0 {
    0.0
  } else {
    value
  }
}

///|
fn named_value(text : String, key : String) -> Double {
  for line_view in text.split("\n") {
    let line = line_view.to_owned()
    let pair = fields_pair(line, ":")
    if pair.length() == 2 && pair[0] == key {
      return number(fields(pair[1])[0])
    }
  }
  0.0
}

///|
fn cpu_counters(stat : String) -> (Double, Double) {
  for line_view in stat.split("\n") {
    let line = line_view.to_owned()
    if line.has_prefix("cpu ") {
      let v = fields(line)
      let user = number(v[1])
      let nice = number(v[2])
      let system = number(v[3])
      let idle = number(v[4])
      let iowait = number(v[5])
      let irq = number(v[6])
      let softirq = number(v[7])
      let steal = number(v[8])
      let total = user + nice + system + idle + iowait + irq + softirq + steal
      return (total, total - idle - iowait)
    }
  }
  (0.0, 0.0)
}

///|
fn network_counters(dev : String) -> (Double, Double) {
  let mut rx = 0.0
  let mut tx = 0.0
  for line_view in dev.split("\n") {
    let line = line_view.to_owned()
    let pair = fields_pair(line, ":")
    if pair.length() == 2 {
      let iface = pair[0].trim()
      if iface != "lo" && iface != "Inter-" && iface != "face" {
        let v = fields(pair[1])
        if v.length() >= 9 {
          rx = rx + number(v[0])
          tx = tx + number(v[8])
        }
      }
    }
  }
  (rx, tx)
}

///|
fn fields_pair(line : String, delimiter : String) -> Array[String] {
  let out : Array[String] = []
  for part in line.split(delimiter) {
    out.push(part.to_owned())
  }
  out
}

///|
fn csv_fields(line : String) -> Array[String] {
  fields_pair(line, ",")
}

///|
fn collect_macos(previous_net : (Double, Double), elapsed : Double) -> MetricPayload {
  let values = csv_fields(macos_metrics())
  if values.length() != 7 {
    eprintln("unable to read required macOS metrics")
    process_exit(2)
  }
  let (old_rx, old_tx) = previous_net
  let safe_elapsed = if elapsed <= 0.0 { 1.0 } else { elapsed }
  let rx = number(values[4])
  let tx = number(values[5])
  MetricPayload::{
    host: {
      let h = env("CFMON_HOST")
      if h == "" { hostname() } else { h }
    },
    os: "macos",
    cpu: clamp(number(values[0]), 0.0, 1.0),
    memory: clamp(number(values[1]), 0.0, 1.0),
    load1: nonnegative(number(values[2])),
    disk: clamp(number(values[3]), 0.0, 1.0),
    rx_bps: nonnegative((rx - old_rx) / safe_elapsed),
    tx_bps: nonnegative((tx - old_tx) / safe_elapsed),
    uptime: nonnegative(number(values[6])),
  }
}

///|
fn collect(
  previous_cpu : (Double, Double),
  previous_net : (Double, Double),
  elapsed : Double,
) -> MetricPayload {
  if os_name() == "macos" {
    return collect_macos(previous_net, elapsed)
  }
  let stat = read_file(@utf8.encode("/proc/stat"))
  let mem = read_file(@utf8.encode("/proc/meminfo"))
  let load_text = read_file(@utf8.encode("/proc/loadavg"))
  let up_text = read_file(@utf8.encode("/proc/uptime"))
  let dev = read_file(@utf8.encode("/proc/net/dev"))
  if stat == "" || mem == "" || load_text == "" || up_text == "" || dev == "" {
    eprintln("unable to read required Linux /proc metrics")
    process_exit(2)
  }
  let (total, busy) = cpu_counters(stat)
  let (old_total, old_busy) = previous_cpu
  let cpu = if old_total <= 0.0 || total <= old_total {
    0.0
  } else {
    (busy - old_busy) / (total - old_total)
  }
  let total_mem = named_value(mem, "MemTotal")
  let available = named_value(mem, "MemAvailable")
  let memory = if total_mem == 0.0 { 0.0 } else { 1.0 - available / total_mem }
  let load = fields(load_text)
  let up = fields(up_text)
  if load.length() == 0 || up.length() == 0 {
    eprintln("invalid Linux /proc metrics")
    process_exit(2)
  }
  let (rx, tx) = network_counters(dev)
  let (old_rx, old_tx) = previous_net
  let safe_elapsed = if elapsed <= 0.0 { 1.0 } else { elapsed }
  MetricPayload::{
    host: {
      let h = env("CFMON_HOST")
      if h == "" {
        hostname()
      } else {
        h
      }
    },
    os: "linux",
    cpu: clamp(cpu, 0.0, 1.0),
    memory: clamp(memory, 0.0, 1.0),
    load1: number(load[0]),
    disk: disk_used(),
    rx_bps: nonnegative((rx - old_rx) / safe_elapsed),
    tx_bps: nonnegative((tx - old_tx) / safe_elapsed),
    uptime: number(up[0]),
  }
}

///|
fn current_cpu() -> (Double, Double) {
  cpu_counters(read_file(@utf8.encode("/proc/stat")))
}

///|
fn current_network() -> (Double, Double) {
  if os_name() == "macos" {
    let values = csv_fields(macos_metrics())
    if values.length() == 7 {
      return (number(values[4]), number(values[5]))
    }
    return (0.0, 0.0)
  }
  network_counters(read_file(@utf8.encode("/proc/net/dev")))
}

///|
test "cpu excludes guest counters and computes busy delta" {
  let (old_total, old_busy) = cpu_counters("cpu 100 0 100 800 0 0 0 0 40 10\n")
  let (new_total, new_busy) = cpu_counters("cpu 110 0 110 880 0 0 0 0 70 20\n")
  assert_eq(old_total, 1000.0)
  assert_eq(new_total - old_total, 100.0)
  assert_eq((new_busy - old_busy) / (new_total - old_total), 0.2)
}

///|
test "memory uses MemAvailable and network excludes loopback" {
  assert_eq(
    named_value("MemTotal: 1000 kB\nMemAvailable: 250 kB\n", "MemAvailable"),
    250.0,
  )
  let (rx, tx) = network_counters(
    "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n",
  )
  assert_eq(rx, 100.0)
  assert_eq(tx, 200.0)
}

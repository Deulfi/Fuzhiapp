#include "wuzhi_protocol.h"

#include <cstdio>
#include <cstring>

namespace wuzhi_proto {

std::string to_hex(const uint8_t *data, size_t len) {
  static const char *digits = "0123456789abcdef";
  std::string s;
  s.reserve(len * 3);
  for (size_t i = 0; i < len; i++) {
    if (i) s.push_back(' ');
    s.push_back(digits[data[i] >> 4]);
    s.push_back(digits[data[i] & 0x0f]);
  }
  return s;
}

// ------------------------------------------------------------------- SAFER+ ---
// Bluetooth legacy-authentication function E1 (Bluetooth Core Specification, Vol 2,
// Part H). Port of src/protocol/auth.ts.

const uint8_t DEFAULT_LINK_KEY[16] = {0x06, 0x77, 0x5f, 0x87, 0x91, 0x8d, 0xd4, 0x23,
                                      0x00, 0x5d, 0xf1, 0xd8, 0xcf, 0x0c, 0x14, 0x2b};
const uint8_t FIXED_ADDR[6] = {0x11, 0x22, 0x33, 0x33, 0x22, 0x11};
const uint8_t AUTH_PASS[5] = {0x02, 0x70, 0x61, 0x73, 0x73};

namespace {

struct Tables {
  uint8_t exp[256];
  uint8_t log[256];
  Tables() {
    unsigned v = 1;
    for (int i = 0; i < 256; i++) {
      exp[i] = static_cast<uint8_t>(v % 256);  // 45^i mod 257; 256 (i = 128) maps to 0
      v = (v * 45) % 257;
    }
    for (int i = 0; i < 256; i++) log[exp[i]] = static_cast<uint8_t>(i);
  }
};

const Tables &tables() {
  static const Tables t;
  return t;
}

// Byte positions XORed in the first key mix and added in the second.
inline bool xor_pos(int i) {
  int m = i & 3;
  return m == 0 || m == 3;  // 0, 3, 4, 7, 8, 11, 12, 15
}

const uint8_t SHUFFLE[16] = {8, 11, 12, 15, 2, 1, 6, 5, 10, 9, 14, 13, 0, 7, 4, 3};

inline uint8_t rotl3(uint8_t b) { return static_cast<uint8_t>((b << 3) | (b >> 5)); }

void key_schedule(const uint8_t key[16], uint8_t sk[17][16]) {
  const Tables &t = tables();
  uint8_t k[17];
  uint8_t x = 0;
  for (int i = 0; i < 16; i++) {
    k[i] = key[i];
    x ^= key[i];
  }
  k[16] = x;
  memcpy(sk[0], key, 16);
  for (int p = 2; p <= 17; p++) {
    for (int i = 0; i < 17; i++) k[i] = rotl3(k[i]);
    for (int i = 0; i < 16; i++) {
      uint8_t bias = t.exp[t.exp[(17 * p + i + 1) & 0xff]];
      sk[p - 1][i] = static_cast<uint8_t>(k[(p - 1 + i) % 17] + bias);
    }
  }
}

void key_mix1(uint8_t x[16], const uint8_t k[16]) {
  for (int i = 0; i < 16; i++) x[i] = xor_pos(i) ? (x[i] ^ k[i]) : static_cast<uint8_t>(x[i] + k[i]);
}

void key_mix2(uint8_t x[16], const uint8_t k[16]) {
  for (int i = 0; i < 16; i++) x[i] = xor_pos(i) ? static_cast<uint8_t>(x[i] + k[i]) : (x[i] ^ k[i]);
}

void pht_layer(uint8_t x[16]) {
  for (int i = 0; i < 16; i += 2) {
    uint8_t a = x[i], b = x[i + 1];
    x[i] = static_cast<uint8_t>(2 * a + b);
    x[i + 1] = static_cast<uint8_t>(a + b);
  }
}

void linear(uint8_t x[16]) {
  for (int r = 0; r < 3; r++) {
    pht_layer(x);
    uint8_t y[16];
    for (int j = 0; j < 16; j++) y[j] = x[SHUFFLE[j]];
    memcpy(x, y, 16);
  }
  pht_layer(x);
}

void safer_round(uint8_t x[16], const uint8_t k1[16], const uint8_t k2[16]) {
  const Tables &t = tables();
  key_mix1(x, k1);
  for (int i = 0; i < 16; i++) x[i] = xor_pos(i) ? t.exp[x[i]] : t.log[x[i]];
  key_mix2(x, k2);
  linear(x);
}

// SAFER+ encryption (Ar), or the modified Ar' when prime is true.
void safer_plus(const uint8_t key[16], const uint8_t data[16], bool prime, uint8_t out[16]) {
  uint8_t sk[17][16];
  key_schedule(key, sk);
  uint8_t x[16];
  memcpy(x, data, 16);
  for (int r = 1; r <= 8; r++) {
    if (prime && r == 3) key_mix1(x, data);  // Ar': original input mixed into round 3
    safer_round(x, sk[2 * r - 2], sk[2 * r - 1]);
  }
  key_mix1(x, sk[16]);
  memcpy(out, x, 16);
}

void offset_key(const uint8_t k[16], uint8_t out[16]) {
  static const uint8_t c[8] = {233, 229, 223, 193, 179, 167, 149, 131};
  for (int i = 0; i < 16; i++) {
    bool add = i < 8 ? (i % 2 == 0) : (i % 2 == 1);
    uint8_t ci = c[i % 8];
    out[i] = add ? static_cast<uint8_t>(k[i] + ci) : (k[i] ^ ci);
  }
}

}  // namespace

void e1(const uint8_t key[16], const uint8_t rand[16], const uint8_t addr6[6], uint8_t out[16]) {
  uint8_t t[16];
  safer_plus(key, rand, false, t);
  uint8_t mixed[16];
  for (int i = 0; i < 16; i++) mixed[i] = static_cast<uint8_t>(addr6[i % 6] + (t[i] ^ rand[i]));
  uint8_t ok[16];
  offset_key(key, ok);
  safer_plus(ok, mixed, true, out);
}

Bytes auth_challenge(const uint8_t random16[16]) {
  Bytes out(17);
  out[0] = AUTH_CHALLENGE;
  memcpy(&out[1], random16, 16);
  return out;
}

Bytes auth_response(const uint8_t challenge16[16], const uint8_t key[16]) {
  Bytes out(17);
  out[0] = AUTH_RESPONSE;
  e1(key, challenge16, FIXED_ADDR, &out[1]);
  return out;
}

// -------------------------------------------------------------- AuthSession ---

AuthSession::Step AuthSession::begin(const uint8_t random16[16]) {
  memcpy(r_host_, random16, 16);
  have_early_challenge_ = false;
  error_.clear();
  state_ = WAIT_DEVICE_RESPONSE;
  Step s;
  s.send.push_back(auth_challenge(r_host_));
  s.log = "auth 1: send challenge";
  return s;
}

int AuthSession::waiting_step() const {
  switch (state_) {
    case WAIT_DEVICE_RESPONSE: return 2;
    case WAIT_DEVICE_CHALLENGE: return 4;
    case WAIT_DEVICE_PASS: return 5;
    default: return 0;
  }
}

void AuthSession::answer_challenge(const uint8_t *challenge16, Step &step) {
  step.send.push_back(auth_response(challenge16));
  state_ = WAIT_DEVICE_PASS;
}

AuthSession::Step AuthSession::feed(const uint8_t *data, size_t len) {
  Step s;
  const bool is_pass = len == sizeof(AUTH_PASS) && memcmp(data, AUTH_PASS, sizeof(AUTH_PASS)) == 0;
  const bool is_response = len == 17 && data[0] == AUTH_RESPONSE;
  const bool is_challenge = len == 17 && data[0] == AUTH_CHALLENGE;

  switch (state_) {
    case WAIT_DEVICE_RESPONSE:
      if (is_challenge) {
        // Messages are matched by type, like handshake.ts: keep it for step 4.
        memcpy(early_challenge_, data + 1, 16);
        have_early_challenge_ = true;
        s.log = "auth: device challenge arrived early, kept for step 4";
        return s;
      }
      if (!is_response) {
        s.log = "auth: ignoring unexpected message " + to_hex(data, len);
        return s;
      }
      {
        uint8_t expected[16];
        e1(DEFAULT_LINK_KEY, r_host_, FIXED_ADDR, expected);
        if (memcmp(expected, data + 1, 16) != 0) {
          state_ = FAILED;
          error_ = "device response mismatch: got " + to_hex(data + 1, 16) + ", expected " + to_hex(expected, 16);
          s.log = "auth 2: " + error_;
          return s;
        }
      }
      s.log = "auth 2: device response verified; auth 3: send pass";
      s.send.push_back(Bytes(AUTH_PASS, AUTH_PASS + sizeof(AUTH_PASS)));
      state_ = WAIT_DEVICE_CHALLENGE;
      if (have_early_challenge_) {
        s.log += "; auth 4: answer device challenge";
        answer_challenge(early_challenge_, s);
      }
      return s;

    case WAIT_DEVICE_CHALLENGE:
      if (!is_challenge) {
        s.log = "auth: ignoring unexpected message " + to_hex(data, len);
        return s;
      }
      s.log = "auth 4: answer device challenge";
      answer_challenge(data + 1, s);
      return s;

    case WAIT_DEVICE_PASS:
      if (!is_pass) {
        s.log = "auth: ignoring unexpected message " + to_hex(data, len);
        return s;
      }
      state_ = DONE;
      s.log = "auth 5: device says pass, authenticated";
      return s;

    default:
      s.log = "auth: message outside handshake ignored";
      return s;
  }
}

// ------------------------------------------------------------------- frames ---

Bytes encode_raw(uint8_t flags, uint8_t opcode, const Bytes &params) {
  Bytes out;
  out.reserve(HEADER_LEN + params.size() + 1);
  out.push_back(0xFE);
  out.push_back(0xDC);
  out.push_back(0xBA);
  out.push_back(flags);
  out.push_back(opcode);
  out.push_back(static_cast<uint8_t>(params.size() >> 8));
  out.push_back(static_cast<uint8_t>(params.size() & 0xff));
  out.insert(out.end(), params.begin(), params.end());
  out.push_back(FRAME_EOF);
  return out;
}

Bytes encode_command(uint8_t opcode, uint8_t sn, const Bytes &payload, bool expect_response) {
  Bytes params;
  params.reserve(1 + payload.size());
  params.push_back(sn);
  params.insert(params.end(), payload.begin(), payload.end());
  uint8_t flags = FLAG_COMMAND | (expect_response ? FLAG_EXPECT_RESPONSE : 0);
  return encode_raw(flags, opcode, params);
}

bool decode_frame(const Bytes &raw, Frame &f) {
  if (raw.size() < HEADER_LEN + 1) return false;
  f.flags = raw[3];
  f.opcode = raw[4];
  f.is_command = (f.flags & FLAG_COMMAND) != 0;
  f.expects_response = (f.flags & FLAG_EXPECT_RESPONSE) != 0;
  const uint8_t *params = raw.data() + HEADER_LEN;
  size_t plen = raw.size() - HEADER_LEN - 1;
  if (f.is_command) {
    if (plen < 1) return false;
    f.status = 0;
    f.sn = params[0];
    f.payload.assign(params + 1, params + plen);
  } else {
    if (plen < 2) return false;
    f.status = params[0];
    f.sn = params[1];
    f.payload.assign(params + 2, params + plen);
  }
  f.raw = raw;
  return true;
}

Bytes ack_for(const Frame &f) { return encode_raw(0x00, f.opcode, Bytes{0x00, f.sn}); }

void FrameReassembler::drop_front(size_t n) {
  if (n == 0) return;
  discarded_ += n;
  buf_.erase(buf_.begin(), buf_.begin() + n);
}

std::vector<Frame> FrameReassembler::push(const uint8_t *data, size_t len) {
  buf_.insert(buf_.end(), data, data + len);
  std::vector<Frame> out;
  for (;;) {
    // find SOF
    size_t start = SIZE_MAX;
    for (size_t i = 0; i + 2 < buf_.size(); i++) {
      if (buf_[i] == 0xFE && buf_[i + 1] == 0xDC && buf_[i + 2] == 0xBA) {
        start = i;
        break;
      }
    }
    if (start == SIZE_MAX) {
      // keep a possible partial SOF at the end (FE or FE DC)
      size_t n = buf_.size(), keep = 0;
      if (n >= 2 && buf_[n - 2] == 0xFE && buf_[n - 1] == 0xDC)
        keep = 2;
      else if (n >= 1 && buf_[n - 1] == 0xFE)
        keep = 1;
      drop_front(n - keep);
      return out;
    }
    drop_front(start);
    if (buf_.size() < HEADER_LEN) return out;
    size_t plen = (static_cast<size_t>(buf_[5]) << 8) | buf_[6];
    if (plen > max_param_len_) {
      drop_front(1);
      continue;
    }
    size_t total = HEADER_LEN + plen + 1;
    if (buf_.size() < total) return out;
    Bytes raw(buf_.begin(), buf_.begin() + total);
    Frame f;
    if (raw[total - 1] != FRAME_EOF || !decode_frame(raw, f)) {
      drop_front(1);  // this SOF was not a real frame start
      continue;
    }
    out.push_back(std::move(f));
    buf_.erase(buf_.begin(), buf_.begin() + total);
  }
}

// ------------------------------------------------------------ target info ---

bool parse_tlvs(const uint8_t *data, size_t len, std::vector<Tlv> &out) {
  size_t i = 0;
  while (i < len) {
    size_t l = data[i];
    if (l < 1 || i + 1 + l > len) return false;
    Tlv t;
    t.type = data[i + 1];
    t.data.assign(data + i + 2, data + i + 1 + l);
    out.push_back(std::move(t));
    i += 1 + l;
  }
  return true;
}

Bytes target_info_all_payload() { return Bytes{0xFF, 0xFF, 0xFF, 0xFF, 0x00}; }

bool parse_target_info(const Bytes &payload, TargetInfo &info) {
  info = TargetInfo{};
  if (!parse_tlvs(payload.data(), payload.size(), info.tlvs)) return false;
  for (const Tlv &t : info.tlvs) {
    const Bytes &d = t.data;
    if (t.type == 0 && d.size() >= 1) {
      info.has_protocol_version = true;
      info.protocol_version = d[0];
    } else if (t.type == 1 && d.size() >= 4) {
      info.has_power = true;
      info.battery = d[0];
      info.volume = d[1];
      info.max_volume = d[2];
      info.power_flags = d[3];
    } else if (t.type == 2 && d.size() >= 8) {
      info.has_edr = true;
      info.edr_profile = d[6];
      info.edr_status = d[7];
    } else if (t.type == 4 && d.size() >= 4) {
      info.has_functions = true;
      info.function_mask = (static_cast<uint32_t>(d[0]) << 24) | (static_cast<uint32_t>(d[1]) << 16) |
                           (static_cast<uint32_t>(d[2]) << 8) | d[3];
      if (d.size() >= 5) {
        info.has_current_function = true;
        info.current_function = d[4];
      }
    }
  }
  return true;
}

const char *function_name(uint8_t fn) {
  switch (fn) {
    case 0: return "Bluetooth";
    case 1: return "Music (USB/SD)";
    case 2: return "RTC/alarm";
    case 3: return "AUX";
    case 4: return "FM";
    case 5: return "Light";
    case 6: return "FM transmit";
    case 7: return "EQ";
    case 0x16: return "low-power";
    case 0xFF: return "public";
    default: return "unknown";
  }
}

namespace {

const char *tlv_name(uint8_t type) {
  switch (type) {
    case 0: return "protocol version";
    case 1: return "power-up info";
    case 2: return "EDR address";
    case 3: return "platform";
    case 4: return "function info";
    case 5: return "firmware info";
    case 6: return "SDK type";
    case 7: return "bootloader version";
    case 8: return "OTA backup flag";
    case 9: return "upgrade flag";
    case 10: return "VID/PID";
    case 11: return "auth key";
    case 12: return "project code";
    case 13: return "MTU";
    case 14: return "allow-connect flag";
    case 16: return "device name";
    case 17: return "BLE-only flag";
    case 19: return "supported functions";
    case 31: return "custom version";
    default: return "unknown";
  }
}

std::string fmt(const char *f, unsigned a) {
  char b[48];
  snprintf(b, sizeof b, f, a);
  return b;
}

}  // namespace

std::string describe_target_info(const TargetInfo &t) {
  std::string s;
  auto add = [&s](const std::string &part) {
    if (!s.empty()) s += "; ";
    s += part;
  };
  if (t.has_protocol_version) {
    char b[24];
    snprintf(b, sizeof b, "proto %u.%u", t.protocol_version >> 4, t.protocol_version & 0x0f);
    add(b);
  }
  if (t.has_power) {
    char b[48];
    snprintf(b, sizeof b, "vol %u/%u; flags 0x%x", t.volume, t.max_volume, t.power_flags);
    add(b);
  }
  if (t.has_edr) add(std::string("A2DP ") + (t.edr_status ? "connected" : "not connected"));
  if (t.has_functions) {
    std::string fs;
    for (int i = 0; i < 32; i++) {
      if (t.function_mask & (1u << i)) {
        if (!fs.empty()) fs += ", ";
        const char *n = function_name(static_cast<uint8_t>(i));
        fs += strcmp(n, "unknown") == 0 ? fmt("function 0x%x", i) : n;
      }
    }
    add("functions [" + fs + "]");
  }
  if (t.has_current_function) add(std::string("current ") + function_name(t.current_function));
  std::string types;
  for (const Tlv &x : t.tlvs) {
    if (!types.empty()) types += " ";
    types += fmt("%x", x.type);
  }
  add("types [" + types + "]");
  return s;
}

std::vector<std::string> describe_tlvs(const TargetInfo &t, bool include_private) {
  std::vector<std::string> lines;
  for (const Tlv &x : t.tlvs) {
    char head[64];
    snprintf(head, sizeof head, "type 0x%02x (%s), %u bytes: ", x.type, tlv_name(x.type),
             static_cast<unsigned>(x.data.size()));
    std::string body;
    const Bytes &d = x.data;
    if (include_private || d.empty()) {
      body = d.empty() ? "(empty)" : to_hex(d);
      if (x.type == 3 && d.size() > 1) body += " \"" + std::string(d.begin() + 1, d.end()) + "\"";
    } else if (x.type == 2 && d.size() >= 6) {
      body = "xx xx xx xx xx xx";
      if (d.size() > 6) body += " " + to_hex(d.data() + 6, d.size() - 6);
      body += " (address redacted)";
    } else if (x.type == 3) {
      body = fmt("%02x", d[0]);
      if (d.size() > 1) body += fmt(" + ASCII ID string, %u chars (redacted)", static_cast<unsigned>(d.size() - 1));
    } else if (x.type == 17 && d.size() >= 7) {
      body = fmt("%02x", d[0]) + " xx xx xx xx xx xx (address redacted)";
    } else if (x.type == 16) {
      body = to_hex(d) + " \"" + std::string(d.begin(), d.end()) + "\"";
    } else {
      body = to_hex(d);
    }
    lines.push_back(std::string(head) + body);
  }
  return lines;
}

// --------------------------------------------------------------- SysInfo ---

Bytes sys_info_public_all_payload() { return Bytes{0xFF, 0x00, 0x00, 0xFF, 0xF7}; }

Bytes set_gain_payload(int value, int cap) {
  if (cap < 0 || cap > GAIN_LIMIT_MAX || value < 0 || value > cap) return Bytes{};
  return Bytes{0xFF, 0x02, VOLUME_ATTR, static_cast<uint8_t>(value)};
}

int next_gain_step(int from, int to) {
  if (to > from) return from + 1;
  if (to < from) return from - 1;
  return from;
}

bool parse_sys_info(const Bytes &payload, SysInfo &s) {
  s = SysInfo{};
  if (payload.empty()) return false;
  s.function = payload[0];
  if (!parse_tlvs(payload.data() + 1, payload.size() - 1, s.tlvs)) return false;
  s.is_public = s.function == 0xFF;
  if (!s.is_public) return true;
  for (const Tlv &t : s.tlvs) {
    const Bytes &d = t.data;
    if (t.type == 1 && d.size() >= 1) {
      s.has_volume = true;
      s.volume = d[0];
    } else if (t.type == 2 && d.size() >= 1) {
      s.has_aux = true;
      s.aux_inserted = (d[0] & 0x10) != 0;
    } else if (t.type == 4 && d.size() >= 11) {
      s.has_eq = true;
      s.eq_mode = d[0];
      for (int i = 0; i < 10; i++) s.eq_gains[i] = static_cast<int8_t>(d[1 + i]);
    } else if (t.type == 6 && d.size() >= 1) {
      s.has_current_function = true;
      s.current_function = d[0];
    }
  }
  return true;
}

std::string describe_sys_info(const SysInfo &s) {
  std::string out;
  auto add = [&out](const std::string &p) {
    if (!out.empty()) out += "; ";
    out += p;
  };
  if (!s.is_public) {
    add(std::string(function_name(s.function)) + " info");
  } else {
    if (s.has_volume) add(fmt("gain %u", s.volume));
    if (s.has_aux) add(std::string("AUX cable ") + (s.aux_inserted ? "in" : "out"));
    if (s.has_eq) add(fmt("EQ mode %u", s.eq_mode));
    if (s.has_current_function) add(std::string("current ") + function_name(s.current_function));
  }
  std::string types;
  for (const Tlv &x : s.tlvs) {
    if (!types.empty()) types += " ";
    types += fmt("%x", x.type);
  }
  add("attrs [" + types + "]");
  return out;
}

// ---------------------------------------------------------------- source ---

const char *source_name(Source s) {
  switch (s) {
    case Source::BLUETOOTH: return "Bluetooth";
    case Source::AUX: return "AUX";
    case Source::IDLE: return "Idle";
    case Source::OTHER: return "Other";
    default: return "unknown";
  }
}

Source source_from_function(uint8_t fn) {
  if (fn == function_id::BLUETOOTH) return Source::BLUETOOTH;
  if (fn == function_id::AUX) return Source::AUX;
  return Source::OTHER;
}

Source source_from_push(uint8_t v) {
  if (v == 1) return Source::BLUETOOTH;
  if (v == 3) return Source::AUX;
  if (v == 5) return Source::IDLE;
  return Source::OTHER;
}

Bytes function_payload(uint8_t fn) { return Bytes{function_id::PUBLIC, fn}; }

bool split_wuzhi(const Bytes &p, uint8_t &cmd, Bytes &data) {
  if (p.size() < 4 || p[0] != 0xAA || p.back() != 0x55) return false;
  cmd = p[2];
  data.assign(p.begin() + 3, p.end() - 1);
  return true;
}

}  // namespace wuzhi_proto

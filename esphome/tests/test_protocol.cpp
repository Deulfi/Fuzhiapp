// Host tests for the protocol core. Build and run (any C++17 compiler):
//   g++ -std=c++17 -Wall -Wextra -I../components/wuzhi_amp test_protocol.cpp ../components/wuzhi_amp/wuzhi_protocol.cpp -o build/test_protocol
//   build/test_protocol
// Vectors come from docs/PROTOCOL.md §3 and §4. Test data uses made-up addresses and IDs.
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>

#include "wuzhi_protocol.h"

using namespace wuzhi_proto;

static int failures = 0;
static int checks = 0;

#define CHECK(cond)                                                    \
  do {                                                                 \
    checks++;                                                          \
    if (!(cond)) {                                                     \
      failures++;                                                      \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);      \
    }                                                                  \
  } while (0)

#define CHECK_EQ_STR(a, b)                                                                   \
  do {                                                                                       \
    checks++;                                                                                \
    std::string _a = (a), _b = (b);                                                          \
    if (_a != _b) {                                                                          \
      failures++;                                                                            \
      std::printf("FAIL %s:%d:\n  got      %s\n  expected %s\n", __FILE__, __LINE__, _a.c_str(), _b.c_str()); \
    }                                                                                        \
  } while (0)

static Bytes from_hex(const char *s) {
  Bytes out;
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  int hi = -1;
  for (; *s; s++) {
    int v = nib(*s);
    if (v < 0) continue;
    if (hi < 0) {
      hi = v;
    } else {
      out.push_back(static_cast<uint8_t>(hi << 4 | v));
      hi = -1;
    }
  }
  return out;
}

static void test_e1_vectors() {
  struct {
    const char *in, *out;
  } v[] = {
      {"00112233445566778899aabbccddeeff", "26a69c072324c5e660c28ff912dcd857"},
      {"00000000000000000000000000000000", "9e43df377b3a46ce751634667e215de5"},
      {"0102030405060708090a0b0c0d0e0f10", "655d48686e418cf71f25fbc5cbeffa77"},
  };
  for (auto &t : v) {
    Bytes in = from_hex(t.in);
    uint8_t out[16];
    e1(DEFAULT_LINK_KEY, in.data(), FIXED_ADDR, out);
    CHECK_EQ_STR(to_hex(out, 16), to_hex(from_hex(t.out)));
  }
}

static void test_encode() {
  // docs/PROTOCOL.md §3 worked examples
  CHECK_EQ_STR(to_hex(encode_command(op::GET_TARGET_INFO, 1, target_info_all_payload())),
               "fe dc ba c0 03 00 06 01 ff ff ff ff 00 ef");
  CHECK_EQ_STR(to_hex(encode_command(op::GET_SYS_INFO, 2, from_hex("ff00000002"))),
               "fe dc ba c0 07 00 06 02 ff 00 00 00 02 ef");
  CHECK_EQ_STR(to_hex(encode_command(op::FUNCTION, 4, from_hex("ff03"))), "fe dc ba c0 0e 00 03 04 ff 03 ef");
  CHECK_EQ_STR(to_hex(encode_command(op::CUSTOM, 6, from_hex("aa011f55"))), "fe dc ba c0 ff 00 05 06 aa 01 1f 55 ef");
}

static void test_reassembler() {
  // A response (flags 00, status 0, sn 7) split across chunks, garbage in front,
  // and a push (flags C0) in the same chunk as the tail.
  Bytes resp = encode_raw(0x00, 0x03, from_hex("00 07 02 00 21"));
  Bytes push = encode_raw(0xC0, 0x21, from_hex("05 00"));
  Bytes stream = from_hex("11 22 fe");
  stream.insert(stream.end(), resp.begin(), resp.end());
  stream.insert(stream.end(), push.begin(), push.end());

  FrameReassembler r;
  std::vector<Frame> got;
  for (size_t off = 0; off < stream.size(); off += 5) {
    size_t n = std::min<size_t>(5, stream.size() - off);
    auto fs = r.push(stream.data() + off, n);
    got.insert(got.end(), fs.begin(), fs.end());
  }
  CHECK(got.size() == 2);
  if (got.size() == 2) {
    CHECK(!got[0].is_command);
    CHECK(got[0].opcode == 0x03 && got[0].sn == 7 && got[0].status == 0);
    CHECK_EQ_STR(to_hex(got[0].payload), "02 00 21");
    CHECK(got[1].is_command && got[1].expects_response);
    CHECK(got[1].opcode == 0x21 && got[1].sn == 5);
    CHECK_EQ_STR(to_hex(ack_for(got[1])), "fe dc ba 00 21 00 02 00 05 ef");
  }
  CHECK(r.pending() == 0);
  CHECK(r.discarded() == 3);

  // false start: SOF with a bad end byte, then a real frame
  FrameReassembler r2;
  Bytes bad = from_hex("fe dc ba c0 03 00 01 00 00");  // EOF position holds 00
  Bytes good = encode_raw(0x00, 0x07, from_hex("00 01"));
  bad.insert(bad.end(), good.begin(), good.end());
  auto fs = r2.push(bad.data(), bad.size());
  CHECK(fs.size() == 1 && fs[0].opcode == 0x07);
}

// Shaped like the measured ZK-502MT reply (DEVICE_ID_AND_FIRMWARE.md §5), with a
// made-up address and ID string.
static Bytes fake_target_info() {
  Bytes p;
  auto tlv = [&p](uint8_t type, const Bytes &d) {
    p.push_back(static_cast<uint8_t>(d.size() + 1));
    p.push_back(type);
    p.insert(p.end(), d.begin(), d.end());
  };
  tlv(0, from_hex("21"));
  tlv(1, from_hex("32 14 1e 00"));
  tlv(2, from_hex("a1 b2 c3 d4 e5 f6 2d 01"));
  Bytes plat{0x01};
  const char *id = "TESTID-1234567890";
  plat.insert(plat.end(), id, id + strlen(id));
  tlv(3, plat);
  tlv(4, from_hex("00 00 00 0b 00"));
  tlv(6, from_hex("00"));
  tlv(11, Bytes{});
  return p;
}

static void test_target_info() {
  TargetInfo t;
  CHECK(parse_target_info(fake_target_info(), t));
  CHECK(t.has_protocol_version && t.protocol_version == 0x21);
  CHECK(t.has_power && t.volume == 20 && t.max_volume == 30);
  CHECK(t.has_edr && t.edr_status == 1);
  CHECK(t.has_functions && t.function_mask == 0x0b && t.current_function == 0);
  CHECK_EQ_STR(describe_target_info(t),
               "proto 2.1; vol 20/30; flags 0x0; A2DP connected; functions [Bluetooth, Music (USB/SD), AUX]; "
               "current Bluetooth; types [0 1 2 3 4 6 b]");

  std::string redacted;
  for (auto &l : describe_tlvs(t, false)) redacted += l + "\n";
  CHECK(redacted.find("a1 b2") == std::string::npos);
  CHECK(redacted.find("TESTID") == std::string::npos);
  CHECK(redacted.find("xx xx xx xx xx xx 2d 01 (address redacted)") != std::string::npos);
  CHECK(redacted.find("01 + ASCII ID string, 17 chars (redacted)") != std::string::npos);
  CHECK(redacted.find("type 0x0b (auth key), 0 bytes: (empty)") != std::string::npos);

  std::string full;
  for (auto &l : describe_tlvs(t, true)) full += l + "\n";
  CHECK(full.find("a1 b2 c3 d4 e5 f6") != std::string::npos);
  CHECK(full.find("\"TESTID-1234567890\"") != std::string::npos);

  TargetInfo bad;
  Bytes truncated = from_hex("05 01 32 14");
  CHECK(!parse_target_info(truncated, bad));
}

// Simulated amp side of the 5-step handshake.
static void test_auth_session(bool early_challenge) {
  AuthSession a;
  uint8_t r_host[16];
  for (int i = 0; i < 16; i++) r_host[i] = static_cast<uint8_t>(0x40 + i);
  uint8_t r_dev[16];
  for (int i = 0; i < 16; i++) r_dev[i] = static_cast<uint8_t>(0x90 + i);
  Bytes dev_challenge{0x00};
  dev_challenge.insert(dev_challenge.end(), r_dev, r_dev + 16);
  Bytes pass(AUTH_PASS, AUTH_PASS + 5);

  auto s1 = a.begin(r_host);
  CHECK(s1.send.size() == 1 && s1.send[0].size() == 17 && s1.send[0][0] == 0x00);
  CHECK(a.waiting_step() == 2);

  if (early_challenge) {
    auto s = a.feed(dev_challenge.data(), dev_challenge.size());
    CHECK(s.send.empty());
  }

  // step 2: amp answers with E1(R_host)
  Bytes resp = auth_response(&s1.send[0][1]);
  auto s2 = a.feed(resp.data(), resp.size());
  if (early_challenge) {
    CHECK(s2.send.size() == 2);
    CHECK(a.state() == AuthSession::WAIT_DEVICE_PASS);
  } else {
    CHECK(s2.send.size() == 1);
    CHECK(a.state() == AuthSession::WAIT_DEVICE_CHALLENGE);
    auto s4 = a.feed(dev_challenge.data(), dev_challenge.size());
    CHECK(s4.send.size() == 1);
    s2.send.push_back(s4.send[0]);
  }
  CHECK(s2.send[0] == pass);
  // step 4 answer must be 01 || E1(R_dev)
  uint8_t expect[16];
  e1(DEFAULT_LINK_KEY, r_dev, FIXED_ADDR, expect);
  CHECK(s2.send[1].size() == 17 && s2.send[1][0] == 0x01 && memcmp(&s2.send[1][1], expect, 16) == 0);

  a.feed(pass.data(), pass.size());
  CHECK(a.done());
}

static void test_auth_mismatch() {
  AuthSession a;
  uint8_t r[16] = {0};
  a.begin(r);
  Bytes wrong(17, 0x00);
  wrong[0] = 0x01;
  a.feed(wrong.data(), wrong.size());
  CHECK(a.failed());
  CHECK(a.error().find("mismatch") != std::string::npos);
}

static void test_gain() {
  // docs/PROTOCOL.md §3: SetSysInfo volume = 20
  CHECK_EQ_STR(to_hex(encode_command(op::SET_SYS_INFO, 3, set_gain_payload(20, 40))),
               "fe dc ba c0 08 00 05 03 ff 02 01 14 ef");
  CHECK(set_gain_payload(21, 20).empty());  // above the cap
  CHECK(set_gain_payload(-1, 40).empty());
  CHECK(set_gain_payload(30, 41).empty());  // cap itself out of range
  CHECK(!set_gain_payload(0, 0).empty());
  CHECK(next_gain_step(10, 15) == 11);
  CHECK(next_gain_step(10, 5) == 9);
  CHECK(next_gain_step(7, 7) == 7);
  CHECK_EQ_STR(to_hex(sys_info_public_all_payload()), "ff 00 00 ff f7");
}

static void test_sys_info() {
  // public: volume 20, attr 2 with bit 4 (AUX cable in), EQ mode 1 + 10 gains, current AUX
  Bytes p = from_hex("ff 02 01 14 02 02 10 0c 04 01 00 01 02 fe ff 00 00 00 00 00 02 06 03");
  SysInfo s;
  CHECK(parse_sys_info(p, s));
  CHECK(s.is_public && s.has_volume && s.volume == 20);
  CHECK(s.has_aux && s.aux_inserted);
  CHECK(s.has_eq && s.eq_mode == 1 && s.eq_gains[3] == -2 && s.eq_gains[4] == -1);
  CHECK(s.has_current_function && s.current_function == 3);
  CHECK_EQ_STR(describe_sys_info(s), "gain 20; AUX cable in; EQ mode 1; current AUX; attrs [1 2 4 6]");

  // function-specific push after switching to AUX: 03 02 00 01
  SysInfo f;
  CHECK(parse_sys_info(from_hex("03 02 00 01"), f));
  CHECK(!f.is_public && f.function == 3 && !f.has_volume);

  SysInfo bad;
  CHECK(!parse_sys_info(from_hex("ff 05 01 14"), bad));
  CHECK(!parse_sys_info(Bytes{}, bad));
}

static void test_source() {
  CHECK_EQ_STR(to_hex(encode_command(op::FUNCTION, 4, function_payload(function_id::AUX))),
               "fe dc ba c0 0e 00 03 04 ff 03 ef");  // docs/PROTOCOL.md §3
  CHECK_EQ_STR(to_hex(function_payload(function_id::BLUETOOTH)), "ff 00");
  CHECK(source_from_push(1) == Source::BLUETOOTH);
  CHECK(source_from_push(3) == Source::AUX);
  CHECK(source_from_push(5) == Source::IDLE);
  CHECK(source_from_function(0) == Source::BLUETOOTH);
  CHECK(source_from_function(3) == Source::AUX);
  CHECK(source_from_function(1) == Source::OTHER);
  uint8_t cmd = 0;
  Bytes data;
  CHECK(split_wuzhi(from_hex("aa 02 21 03 55"), cmd, data) && cmd == 0x21 && data == Bytes{0x03});
  CHECK(!split_wuzhi(from_hex("aa 02 21 03"), cmd, data));
}

static void test_eq() {
  int8_t g[10] = {0, 1, 2, 3, -3, 13, -13, 0, 0, 12};
  CHECK_EQ_STR(to_hex(set_eq_payload(EQ_MODE_USER, g)), "ff 0c 04 06 00 01 02 03 fd 0c f4 00 00 0c");
  CHECK(set_eq_payload(7, g).empty());
  CHECK_EQ_STR(eq_name(0), "Normal");
  CHECK_EQ_STR(eq_name(6), "User");
}

int main() {
  test_eq();
  test_source();
  test_gain();
  test_sys_info();
  test_e1_vectors();
  test_encode();
  test_reassembler();
  test_target_info();
  test_auth_session(false);
  test_auth_session(true);
  test_auth_mismatch();
  std::printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}

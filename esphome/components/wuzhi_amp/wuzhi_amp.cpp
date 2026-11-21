#include "wuzhi_amp.h"

#ifdef USE_ESP32

#include <esp_gattc_api.h>

#include <algorithm>
#include <cmath>
#include <cstring>

#include "esphome/core/hal.h"
#include "esphome/core/helpers.h"
#include "esphome/core/log.h"

namespace esphome {
namespace wuzhi_amp {

static const char *const TAG = "wuzhi_amp";

namespace proto = wuzhi_proto;

static const uint16_t SERVICE_UUID = 0xAE00;
static const uint16_t WRITE_CHAR_UUID = 0xAE01;   // write without response only
static const uint16_t NOTIFY_CHAR_UUID = 0xAE02;
static const size_t CHUNK = 20;                   // the PWA also writes 20-byte chunks
static const uint32_t AUTH_STEP_TIMEOUT_MS = 2000;  // spec §4: 2 s per step
// The spec allows 3 attempts, but the amp ignores a second challenge on the same link
// (OPEN_QUESTIONS T7). So: one attempt per connection, then reconnect.
static const uint8_t AUTH_MAX_ATTEMPTS = 1;
static const uint32_t CCCD_FALLBACK_MS = 1000;
static const uint32_t PAIR_TIMEOUT_MS = 15000;
static const uint32_t BACKOFF_MIN_MS = 30000;
static const uint32_t BACKOFF_MAX_MS = 600000;
static const uint32_t GAIN_STEP_MS = 120;  // one step of 1 every 120 ms, like the PWA
// Bluetooth audio (TargetInfo type 2 status) has no push; re-read it this often while the
// sensor is configured. Read-only.
static const uint32_t TARGET_POLL_MS = 30000;
static const char *const SOURCE_OPTIONS[] = {"Bluetooth", "AUX", "Idle"};

void WuzhiAmp::setup() {
  this->publish_gain_();  // unknown until the amp reports it
  this->publish_connected_(false);
}

void WuzhiAmp::dump_config() {
  ESP_LOGCONFIG(TAG, "Wuzhi amp bridge:");
  ESP_LOGCONFIG(TAG, "  Query target info on connect: %s", YESNO(this->query_target_info_));
  ESP_LOGCONFIG(TAG, "  Log private identifiers: %s", YESNO(this->log_private_));
  ESP_LOGCONFIG(TAG, "  Auth delay: %u ms", static_cast<unsigned>(this->auth_delay_ms_));
  ESP_LOGCONFIG(TAG, "  Pair: %s", YESNO(this->pair_));
#ifdef USE_NUMBER
  if (this->gain_number_ != nullptr) ESP_LOGCONFIG(TAG, "  Gain number, cap %d", this->max_gain_);
#endif
}

void WuzhiAmp::reset_link_() {
  this->link_ = Link::DISCONNECTED;
  this->write_handle_ = 0;
  this->notify_handle_ = 0;
  this->auth_ = proto::AuthSession();
  this->auth_attempt_ = 0;
  this->auth_step_deadline_ = 0;
  this->cccd_fallback_at_ = 0;
  this->auth_start_at_ = 0;
  this->pair_deadline_ = 0;
  this->reassembler_.reset();
  this->sn_ = 0;
  this->pending_.clear();
  this->gain_current_ = -1;
  this->gain_target_ = -1;
  this->gain_in_flight_ = false;
  this->gain_next_at_ = 0;
  this->publish_gain_();
  this->source_ = proto::Source::UNKNOWN;
  this->aux_cable_ = -1;
  this->bt_audio_ = -1;
  this->source_in_flight_ = false;
  this->target_info_logged_ = false;
  this->next_target_poll_at_ = 0;
  this->publish_connected_(false);
}

void WuzhiAmp::gattc_event_handler(esp_gattc_cb_event_t event, esp_gatt_if_t gattc_if,
                                   esp_ble_gattc_cb_param_t *param) {
  switch (event) {
    case ESP_GATTC_OPEN_EVT:
      if (param->open.status == ESP_GATT_OK) ESP_LOGI(TAG, "Connected to amp, discovering services");
      break;

    case ESP_GATTC_DISCONNECT_EVT:
    case ESP_GATTC_CLOSE_EVT:
      if (this->link_ != Link::DISCONNECTED) ESP_LOGW(TAG, "Disconnected from amp");
      this->reset_link_();
      this->node_state = espbt::ClientState::IDLE;
      break;

    case ESP_GATTC_SEARCH_CMPL_EVT: {
      auto *wr = this->parent()->get_characteristic(espbt::ESPBTUUID::from_uint16(SERVICE_UUID),
                                                    espbt::ESPBTUUID::from_uint16(WRITE_CHAR_UUID));
      auto *nt = this->parent()->get_characteristic(espbt::ESPBTUUID::from_uint16(SERVICE_UUID),
                                                    espbt::ESPBTUUID::from_uint16(NOTIFY_CHAR_UUID));
      if (wr == nullptr || nt == nullptr) {
        ESP_LOGE(TAG, "Service AE00 with AE01/AE02 not found. Is this the amp?");
        break;
      }
      this->write_handle_ = wr->handle;
      this->notify_handle_ = nt->handle;
      ESP_LOGD(TAG, "AE01 handle 0x%04x properties 0x%02x, AE02 handle 0x%04x properties 0x%02x", wr->handle,
               wr->properties, nt->handle, nt->properties);
      // ble_client marks every node ESTABLISHED at SEARCH_CMPL and then frees its GATT cache once
      // all nodes are established and no counted notify registration is pending. The CCCD lookup
      // needs that cache, so: stay CONNECTED until notifications are on.
      this->node_state = espbt::ClientState::CONNECTED;
      if (this->pair_) {
        // Optional: the ZK-502MT also works without it. With a stored bond this just
        // resumes encryption.
        ESP_LOGI(TAG, "Pairing / encrypting the link");
        this->link_ = Link::PAIRING;
        this->pair_deadline_ = millis() + PAIR_TIMEOUT_MS;
        auto err = this->parent()->pair();
        if (err != ESP_OK) {
          ESP_LOGE(TAG, "Starting encryption failed: %d", err);
          this->fail_and_back_off_();
        }
        break;
      }
      this->enable_notifications_();
      break;
    }

    case ESP_GATTC_REG_FOR_NOTIFY_EVT:
      if (param->reg_for_notify.handle != this->notify_handle_) break;
      if (param->reg_for_notify.status != ESP_GATT_OK) {
        ESP_LOGE(TAG, "Notify registration failed: %d", param->reg_for_notify.status);
        break;
      }
      // ble_client has now sent the CCCD write; auth starts when it is confirmed
      // (ESP_GATTC_WRITE_DESCR_EVT), or after a short fallback delay.
      this->cccd_fallback_at_ = millis() + CCCD_FALLBACK_MS;
      break;

    case ESP_GATTC_WRITE_DESCR_EVT:
      if (this->link_ != Link::DISCOVERED || this->cccd_fallback_at_ == 0) break;
      if (param->write.status != ESP_GATT_OK) {
        ESP_LOGW(TAG, "Enabling notifications on AE02 failed, status %d", param->write.status);
      } else {
        ESP_LOGD(TAG, "Notifications on AE02 enabled");
      }
      this->cccd_fallback_at_ = 0;
      this->node_state = espbt::ClientState::ESTABLISHED;
      this->schedule_auth_();
      break;

    case ESP_GATTC_NOTIFY_EVT:
      if (this->link_ == Link::AUTHENTICATING || param->notify.handle != this->notify_handle_) {
        ESP_LOGD(TAG, "rx %s on handle 0x%04x, %u bytes", param->notify.is_notify ? "notification" : "indication",
                 param->notify.handle, static_cast<unsigned>(param->notify.value_len));
      }
      if (param->notify.handle != this->notify_handle_) break;
      this->on_notify_(param->notify.value, param->notify.value_len);
      break;

    default:
      break;
  }
}

void WuzhiAmp::enable_notifications_() {
  // Registered through the client so the registration is counted and the GATT cache kept.
  auto err = this->parent()->register_for_notify(this->notify_handle_);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "register_for_notify failed: %d", err);
    return;
  }
  this->link_ = Link::DISCOVERED;
}

void WuzhiAmp::gap_event_handler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param) {
  if (event != ESP_GAP_BLE_AUTH_CMPL_EVT || this->link_ != Link::PAIRING) return;
  if (memcmp(param->ble_security.auth_cmpl.bd_addr, this->parent()->get_remote_bda(), 6) != 0) return;
  this->pair_deadline_ = 0;
  if (!param->ble_security.auth_cmpl.success) {
    ESP_LOGE(TAG, "Pairing failed, reason 0x%02x", param->ble_security.auth_cmpl.fail_reason);
    this->fail_and_back_off_();
    return;
  }
  ESP_LOGI(TAG, "Link encrypted (auth mode %d)", param->ble_security.auth_cmpl.auth_mode);
  this->enable_notifications_();
}

void WuzhiAmp::loop() {
  const uint32_t now = millis();

  if (this->reconnect_at_ != 0 && static_cast<int32_t>(now - this->reconnect_at_) >= 0) {
    this->reconnect_at_ = 0;
    ESP_LOGI(TAG, "Back-off over, allowing reconnect");
    this->parent()->set_auto_connect(true);
  }

  if (this->link_ == Link::PAIRING && this->pair_deadline_ != 0 &&
      static_cast<int32_t>(now - this->pair_deadline_) >= 0) {
    ESP_LOGE(TAG, "Pairing timed out");
    this->pair_deadline_ = 0;
    this->fail_and_back_off_();
  }

  if (this->link_ == Link::DISCOVERED && this->cccd_fallback_at_ != 0 &&
      static_cast<int32_t>(now - this->cccd_fallback_at_) >= 0) {
    ESP_LOGW(TAG, "No confirmation for enabling notifications, starting auth anyway");
    this->node_state = espbt::ClientState::ESTABLISHED;
    this->cccd_fallback_at_ = 0;
    this->schedule_auth_();
  }

  if (this->link_ == Link::DISCOVERED && this->auth_start_at_ != 0 &&
      static_cast<int32_t>(now - this->auth_start_at_) >= 0) {
    this->auth_start_at_ = 0;
    this->start_auth_();
  }

  if (this->link_ == Link::READY) {
    this->step_gain_();
    if (this->needs_target_poll_() && this->next_target_poll_at_ != 0 &&
        static_cast<int32_t>(now - this->next_target_poll_at_) >= 0) {
      this->next_target_poll_at_ = now + TARGET_POLL_MS;
      this->query_target_info_now_();
    }
  }

  if (this->link_ == Link::AUTHENTICATING && this->auth_step_deadline_ != 0 &&
      static_cast<int32_t>(now - this->auth_step_deadline_) >= 0) {
    ESP_LOGW(TAG, "auth: timeout waiting for step %d", this->auth_.waiting_step());
    this->start_auth_();  // next attempt, or give up
  }

  // Reply timeouts. Handlers may add new requests, so collect first.
  std::vector<Pending> expired;
  for (auto it = this->pending_.begin(); it != this->pending_.end();) {
    if (static_cast<int32_t>(now - it->deadline) >= 0) {
      expired.push_back(std::move(*it));
      it = this->pending_.erase(it);
    } else {
      ++it;
    }
  }
  for (auto &p : expired) {
    ESP_LOGW(TAG, "No reply to opcode 0x%02x sn %u", p.opcode, p.sn);
    if (p.handler) p.handler(nullptr);
  }
}

void WuzhiAmp::schedule_auth_() {
  ESP_LOGD(TAG, "Starting auth in %u ms", static_cast<unsigned>(this->auth_delay_ms_));
  this->auth_start_at_ = millis() + this->auth_delay_ms_;
  if (this->auth_start_at_ == 0) this->auth_start_at_ = 1;
}

void WuzhiAmp::start_auth_() {
  if (this->auth_attempt_ >= AUTH_MAX_ATTEMPTS) {
    ESP_LOGE(TAG, "auth failed");
    this->auth_step_deadline_ = 0;
    this->link_ = Link::DISCOVERED;
    this->fail_and_back_off_();
    return;
  }
  this->auth_attempt_++;
  this->link_ = Link::AUTHENTICATING;
  uint8_t r[16];
  for (int i = 0; i < 16; i += 4) {
    uint32_t v = random_uint32();
    memcpy(r + i, &v, 4);
  }
  ESP_LOGD(TAG, "auth attempt %u", this->auth_attempt_);
  this->handle_auth_step_(this->auth_.begin(r));
}

void WuzhiAmp::handle_auth_step_(const proto::AuthSession::Step &step) {
  if (!step.log.empty()) ESP_LOGD(TAG, "%s", step.log.c_str());
  for (const auto &msg : step.send) this->write_(msg);

  if (this->auth_.done()) {
    this->auth_step_deadline_ = 0;
    this->on_authenticated_();
  } else if (this->auth_.failed()) {
    ESP_LOGW(TAG, "auth attempt %u failed: %s", this->auth_attempt_, this->auth_.error().c_str());
    this->start_auth_();
  } else if (!step.send.empty() || this->auth_step_deadline_ == 0) {
    // A step moved forward: restart the per-step timer.
    this->auth_step_deadline_ = millis() + AUTH_STEP_TIMEOUT_MS;
  }
}

// A failed attempt disconnects and keeps ble_client from reconnecting for a while. Hammering
// the amp with challenges and reconnects once left its control channel stuck until a power
// cycle. Waits 30 s, doubling up to 10 min; reset by a successful auth.
void WuzhiAmp::fail_and_back_off_() {
  uint32_t wait = this->backoff_ms_ == 0 ? BACKOFF_MIN_MS : std::min(this->backoff_ms_ * 2, BACKOFF_MAX_MS);
  this->backoff_ms_ = wait;
  this->reconnect_at_ = millis() + wait;
  if (this->reconnect_at_ == 0) this->reconnect_at_ = 1;
  ESP_LOGW(TAG, "Disconnecting; next connection attempt in %u s", static_cast<unsigned>(wait / 1000));
  this->parent()->set_auto_connect(false);
  this->parent()->disconnect();
}

void WuzhiAmp::on_authenticated_() {
  ESP_LOGI(TAG, "Authenticated with amp");
  this->backoff_ms_ = 0;
  this->link_ = Link::READY;
  this->reassembler_.reset();
  this->publish_connected_(true);
  // Both reads are read-only. GetSysInfo only when an entity needs the amp's state.
  if (this->query_target_info_ || this->needs_target_poll_()) this->query_target_info_now_();
  if (this->needs_sys_info_()) this->query_sys_info_now_();
  if (this->needs_target_poll_()) this->next_target_poll_at_ = millis() + TARGET_POLL_MS;
}

bool WuzhiAmp::needs_sys_info_() const {
  bool need = false;
#ifdef USE_NUMBER
  need |= this->gain_number_ != nullptr;
#endif
#ifdef USE_SELECT
  need |= this->source_select_ != nullptr;
#endif
#ifdef USE_BINARY_SENSOR
  need |= this->aux_cable_sensor_ != nullptr;
#endif
  return need;
}

bool WuzhiAmp::needs_target_poll_() const {
#ifdef USE_BINARY_SENSOR
  return this->bt_audio_sensor_ != nullptr;
#else
  return false;
#endif
}

void WuzhiAmp::on_notify_(const uint8_t *data, size_t len) {
  if (this->link_ == Link::AUTHENTICATING) {
    this->handle_auth_step_(this->auth_.feed(data, len));
    return;
  }
  if (this->link_ != Link::READY) {
    ESP_LOGV(TAG, "rx before auth (%u bytes) ignored", static_cast<unsigned>(len));
    return;
  }
  for (const auto &f : this->reassembler_.push(data, len)) this->on_frame_(f);
}

void WuzhiAmp::on_frame_(const proto::Frame &f) {
  // Raw frame bytes may contain the amp's address and ID string (TargetInfo replies),
  // so they are only logged with log_private.
  if (this->log_private_) {
    ESP_LOGV(TAG, "rx %s", proto::to_hex(f.raw).c_str());
  }

  if (!f.is_command) {
    for (auto it = this->pending_.begin(); it != this->pending_.end(); ++it) {
      if (it->opcode == f.opcode && it->sn == f.sn) {
        ReplyHandler h = std::move(it->handler);
        this->pending_.erase(it);
        if (h) h(&f);
        return;
      }
    }
    ESP_LOGD(TAG, "Unmatched reply: opcode 0x%02x sn %u status %u", f.opcode, f.sn, f.status);
    return;
  }

  // Device push. 0x09 = SysInfo changed (same layout as a GetSysInfo reply).
  ESP_LOGD(TAG, "Push: opcode 0x%02x, %u payload bytes: %s", f.opcode, static_cast<unsigned>(f.payload.size()),
           proto::to_hex(f.payload).c_str());
  if (f.opcode == proto::op::SYS_INFO_PUSH) {
    proto::SysInfo s;
    if (proto::parse_sys_info(f.payload, s)) this->apply_sys_info_(s, "push");
  } else if (f.opcode == proto::op::CUSTOM) {
    uint8_t cmd;
    proto::Bytes data;
    if (proto::split_wuzhi(f.payload, cmd, data) && cmd == proto::wuzhi_cmd::SOURCE_PUSH && data.size() == 1) {
      this->set_source_(proto::source_from_push(data[0]), "push");
    }
  }
  if (f.expects_response) this->write_(proto::ack_for(f));  // bare ack (D6), as the PWA does
}

bool WuzhiAmp::write_(const proto::Bytes &bytes) {
  if (this->write_handle_ == 0) return false;
  // Outgoing bytes carry no address or ID string (auth challenges are random).
  ESP_LOGD(TAG, "tx %u bytes: %s", static_cast<unsigned>(bytes.size()), proto::to_hex(bytes).c_str());
  for (size_t off = 0; off < bytes.size(); off += CHUNK) {
    size_t n = std::min(CHUNK, bytes.size() - off);
    uint8_t buf[CHUNK];
    memcpy(buf, bytes.data() + off, n);
    auto err = esp_ble_gattc_write_char(this->parent()->get_gattc_if(), this->parent()->get_conn_id(),
                                        this->write_handle_, n, buf, ESP_GATT_WRITE_TYPE_NO_RSP,
                                        ESP_GATT_AUTH_REQ_NONE);
    if (err != ESP_OK) {
      ESP_LOGW(TAG, "write failed: %d", err);
      return false;
    }
  }
  return true;
}

bool WuzhiAmp::request_(uint8_t opcode, const proto::Bytes &payload, ReplyHandler handler, uint32_t timeout_ms) {
  if (this->link_ != Link::READY) return false;
  uint8_t sn = this->sn_++;
  // Registered before the write so a fast reply can't be missed.
  this->pending_.push_back(Pending{opcode, sn, millis() + timeout_ms, std::move(handler)});
  if (!this->write_(proto::encode_command(opcode, sn, payload, true))) {
    this->pending_.pop_back();
    return false;
  }
  return true;
}

void WuzhiAmp::query_target_info_now_() {
  ESP_LOGD(TAG, "Sending GetTargetInfo");
  this->request_(proto::op::GET_TARGET_INFO, proto::target_info_all_payload(), [this](const proto::Frame *reply) {
    if (reply == nullptr) return;  // timeout already logged
    if (reply->status != 0) {
      ESP_LOGW(TAG, "GetTargetInfo: status 0x%02x", reply->status);
      return;
    }
    proto::TargetInfo info;
    if (!proto::parse_target_info(reply->payload, info)) {
      ESP_LOGW(TAG, "GetTargetInfo: bad TLV list (%u bytes)", static_cast<unsigned>(reply->payload.size()));
      return;
    }
    if (!this->target_info_logged_) {
      // Full dump once per connection; the periodic re-reads only log the summary.
      this->target_info_logged_ = true;
      ESP_LOGI(TAG, "Target info: %s", proto::describe_target_info(info).c_str());
      for (const auto &line : proto::describe_tlvs(info, this->log_private_)) ESP_LOGI(TAG, "  %s", line.c_str());
    } else {
      ESP_LOGD(TAG, "Target info: %s", proto::describe_target_info(info).c_str());
    }
    this->apply_target_info_(info);
  });
}

void WuzhiAmp::query_sys_info_now_() {
  ESP_LOGD(TAG, "Sending GetSysInfo");
  this->request_(proto::op::GET_SYS_INFO, proto::sys_info_public_all_payload(), [this](const proto::Frame *reply) {
    if (reply == nullptr) return;
    if (reply->status != 0) {
      ESP_LOGW(TAG, "GetSysInfo: status 0x%02x", reply->status);
      return;
    }
    proto::SysInfo s;
    if (!proto::parse_sys_info(reply->payload, s)) {
      ESP_LOGW(TAG, "GetSysInfo: bad TLV list (%u bytes)", static_cast<unsigned>(reply->payload.size()));
      return;
    }
    this->apply_sys_info_(s, "read");
  });
}

void WuzhiAmp::apply_sys_info_(const proto::SysInfo &s, const char *source) {
  ESP_LOGI(TAG, "Sys info (%s): %s", source, proto::describe_sys_info(s).c_str());
  if (!s.is_public) {
    // e.g. 03 02 00 01 after switching to AUX: only the function is useful
    this->set_source_(proto::source_from_function(s.function), source);
  }
  if (s.has_current_function) this->set_source_(proto::source_from_function(s.current_function), source);
  if (s.has_aux) this->set_aux_cable_(s.aux_inserted);
  if (s.has_volume) {
    this->gain_current_ = s.volume;
    // While stepping, the step replies drive the state and only the end value is published.
    if (!this->gain_in_flight_ && this->gain_target_ < 0) this->publish_gain_();
  }
}

void WuzhiAmp::publish_gain_() {
#ifdef USE_NUMBER
  if (this->gain_number_ == nullptr) return;
  this->gain_number_->publish_state(this->gain_current_ < 0 ? NAN : static_cast<float>(this->gain_current_));
#endif
}

void WuzhiAmp::request_gain(float value) {
  if (this->link_ != Link::READY || this->gain_current_ < 0) {
    ESP_LOGW(TAG, "Gain change ignored: amp not connected or gain not known yet");
    this->publish_gain_();  // put the entity back
    return;
  }
  if (std::isnan(value)) return;
  int target = static_cast<int>(std::lround(value));
  if (target < 0) target = 0;
  if (target > this->max_gain_) {
    ESP_LOGW(TAG, "Gain %d is above the cap %d, using %d", target, this->max_gain_, this->max_gain_);
    target = this->max_gain_;
  }
  ESP_LOGI(TAG, "Gain %d -> %d", this->gain_current_, target);
  this->gain_target_ = target;  // a new value while stepping just moves the target
}

void WuzhiAmp::step_gain_() {
  if (this->gain_target_ < 0 || this->gain_in_flight_ || this->gain_current_ < 0) return;
  if (this->gain_target_ == this->gain_current_) {
    this->gain_target_ = -1;
    this->publish_gain_();
    return;
  }
  if (this->gain_next_at_ != 0 && static_cast<int32_t>(millis() - this->gain_next_at_) < 0) return;

  // Above the cap (set elsewhere, e.g. the vendor app): go straight down to the cap, since
  // stepping down would send values above it. Down is the safe direction.
  const int next = this->gain_current_ > this->max_gain_ ? this->max_gain_
                                                         : proto::next_gain_step(this->gain_current_, this->gain_target_);
  proto::Bytes payload = proto::set_gain_payload(next, this->max_gain_);
  if (payload.empty()) {  // can't happen with a clamped target; never send it anyway
    ESP_LOGE(TAG, "Refusing gain %d (cap %d)", next, this->max_gain_);
    this->gain_target_ = -1;
    return;
  }
  this->gain_in_flight_ = true;
  bool sent = this->request_(proto::op::SET_SYS_INFO, payload, [this, next](const proto::Frame *reply) {
    this->gain_in_flight_ = false;
    this->gain_next_at_ = millis() + GAIN_STEP_MS;
    if (reply == nullptr || reply->status != 0) {
      ESP_LOGW(TAG, "Gain step to %d not confirmed, stopping", next);
      this->gain_target_ = -1;
      this->publish_gain_();
      return;
    }
    this->gain_current_ = next;  // published once the target is reached, not per step
  });
  if (!sent) {
    this->gain_in_flight_ = false;
    this->gain_target_ = -1;
    this->publish_gain_();
  }
}

void WuzhiAmp::apply_target_info_(const proto::TargetInfo &t) {
  if (t.has_edr) this->set_bt_audio_(t.edr_status == 1);
  if (t.has_current_function) this->set_source_(proto::source_from_function(t.current_function), "target info");
}

void WuzhiAmp::set_source_(proto::Source s, const char *why) {
  if (s == this->source_) return;  // the amp repeats the 0x21 push 2-4 times
  ESP_LOGI(TAG, "Source: %s (%s)", proto::source_name(s), why);
  this->source_ = s;
  this->publish_source_();
  // A source change often means Bluetooth audio connected or dropped: re-read it.
  if (this->needs_target_poll_() && this->link_ == Link::READY) this->query_target_info_now_();
}

void WuzhiAmp::publish_source_() {
#ifdef USE_SELECT
  if (this->source_select_ == nullptr) return;
  switch (this->source_) {
    case proto::Source::BLUETOOTH: this->source_select_->publish_state(static_cast<size_t>(0)); break;
    case proto::Source::AUX: this->source_select_->publish_state(static_cast<size_t>(1)); break;
    case proto::Source::IDLE: this->source_select_->publish_state(static_cast<size_t>(2)); break;
    default: break;  // unknown / other: keep the last shown value
  }
#endif
}

void WuzhiAmp::set_aux_cable_(bool in) {
  int v = in ? 1 : 0;
  if (v == this->aux_cable_) return;
  ESP_LOGI(TAG, "AUX cable %s", in ? "plugged in" : "unplugged");
  this->aux_cable_ = v;
#ifdef USE_BINARY_SENSOR
  if (this->aux_cable_sensor_ != nullptr) this->aux_cable_sensor_->publish_state(in);
#endif
}

void WuzhiAmp::set_bt_audio_(bool on) {
  int v = on ? 1 : 0;
  if (v == this->bt_audio_) return;
  ESP_LOGI(TAG, "Bluetooth audio %s", on ? "connected" : "not connected");
  this->bt_audio_ = v;
#ifdef USE_BINARY_SENSOR
  if (this->bt_audio_sensor_ != nullptr) this->bt_audio_sensor_->publish_state(on);
#endif
}

void WuzhiAmp::publish_connected_(bool on) {
#ifdef USE_BINARY_SENSOR
  if (this->connected_sensor_ != nullptr) this->connected_sensor_->publish_state(on);
#endif
}

void WuzhiAmp::request_source(size_t index) {
  if (index >= 3) return;
  if (this->link_ != Link::READY || this->source_in_flight_) {
    ESP_LOGW(TAG, "Source change ignored: amp not connected or a change is still running");
    this->publish_source_();
    return;
  }
  if (index == 2) {
    ESP_LOGW(TAG, "Idle is shown, not selectable");
    this->publish_source_();
    return;
  }
  const bool to_aux = index == 1;
  const proto::Source want = to_aux ? proto::Source::AUX : proto::Source::BLUETOOTH;
  // Switching to Bluetooth while on Bluetooth drops the phone's audio link (S4): skip it.
  if (want == this->source_) {
    this->publish_source_();
    return;
  }
  if (to_aux && this->aux_cable_ != 1) {
    // The amp ignores the switch without a cable (DECISIONS, "From the EQ test").
    ESP_LOGW(TAG, "No AUX cable plugged in; not switching");
    this->publish_source_();
    return;
  }
  ESP_LOGI(TAG, "Switching to %s", SOURCE_OPTIONS[index]);
  this->source_in_flight_ = true;
  bool sent = this->request_(proto::op::FUNCTION,
                             proto::function_payload(to_aux ? proto::function_id::AUX : proto::function_id::BLUETOOTH),
                             [this](const proto::Frame *reply) {
                               this->source_in_flight_ = false;
                               if (reply == nullptr || reply->status != 0) {
                                 ESP_LOGW(TAG, "Source switch not confirmed");
                               }
                               // The new source arrives as a push; show the current one meanwhile.
                               this->publish_source_();
                             });
  if (!sent) {
    this->source_in_flight_ = false;
    this->publish_source_();
  }
}

}  // namespace wuzhi_amp
}  // namespace esphome

#endif  // USE_ESP32

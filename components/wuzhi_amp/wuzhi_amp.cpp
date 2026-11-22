#include "wuzhi_amp.h"

#ifdef USE_ESP32

#include <esp_gattc_api.h>

#include <algorithm>
#include <cctype>
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
// Mute and unmute: still steps of 1 upwards, but each one right after the amp confirms the
// last (one write in flight at a time), so 0 -> 20 takes well under a second.
static const uint32_t GAIN_FAST_STEP_MS = 0;
// Bluetooth audio (TargetInfo type 2 status) has no push; re-read it this often while the
// sensor is configured. Read-only.
static const uint32_t TARGET_POLL_MS = 30000;
static const char *const SOURCE_OPTIONS[] = {"Bluetooth", "AUX", "Idle"};
static const uint32_t EQ_CHECK_MS = 3000;  // the amp answers an EQ write with a push of the EQ it uses
// AUX priority timing, DEFAULT_TIMING in src/app/timing.ts
static const uint32_t PRIORITY_GAP_MS = 2000;
static const uint32_t PRIORITY_RECHECK_MS = 2500;
static const uint8_t PRIORITY_MAX_PER_MINUTE = 6;

void WuzhiAmp::setup() {
  // ble_client's mac_address 00:00:00:00:00:00 means: find the amp automatically.
  this->configured_address_ = this->parent()->get_address();
  this->address_pref_ = global_preferences->make_preference<uint64_t>(fnv1_hash("wuzhi_amp_address"));
  if (this->configured_address_ == 0) {
    uint64_t stored = 0;
    if (this->address_pref_.load(&stored) && stored != 0) {
      this->adopted_address_ = stored;
      this->parent()->set_address(stored);
      ESP_LOGI(TAG, "Using the stored amp");
    } else {
      ESP_LOGI(TAG, "No amp stored; looking for one named \"%s...\"", this->name_prefix_.c_str());
    }
  }
  this->publish_gain_();  // unknown until the amp reports it
  this->publish_connected_(false);
#ifdef USE_SWITCH
  if (this->connect_switch_ != nullptr) {
    auto initial = this->connect_switch_->get_initial_state_with_restore_mode();
    this->connect_enabled_ = !initial.has_value() || *initial;
    this->connect_switch_->publish_state(this->connect_enabled_);
    if (!this->connect_enabled_) {
      ESP_LOGI(TAG, "Connect to amp is off: staying disconnected");
      this->parent()->set_auto_connect(false);
    }
  }
  this->publish_mute_();
  if (this->aux_priority_switch_ != nullptr) {
    auto initial = this->aux_priority_switch_->get_initial_state_with_restore_mode();
    this->aux_priority_ = initial.has_value() && *initial;
    this->aux_priority_switch_->publish_state(this->aux_priority_);
  }
#endif
}

void WuzhiAmp::dump_config() {
  ESP_LOGCONFIG(TAG, "Wuzhi amp bridge:");
  ESP_LOGCONFIG(TAG, "  Query target info on connect: %s", YESNO(this->query_target_info_));
  ESP_LOGCONFIG(TAG, "  Log private identifiers: %s", YESNO(this->log_private_));
  ESP_LOGCONFIG(TAG, "  Auth delay: %u ms", static_cast<unsigned>(this->auth_delay_ms_));
  ESP_LOGCONFIG(TAG, "  Pair: %s", YESNO(this->pair_));
  if (this->configured_address_ != 0) {
    ESP_LOGCONFIG(TAG, "  Amp address: from the config");
  } else {
    ESP_LOGCONFIG(TAG, "  Amp address: found automatically (name prefix \"%s\"), %s", this->name_prefix_.c_str(),
                  this->adopted_address_ != 0 ? "stored" : "none yet");
  }
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
  this->eq_mode_ = -1;
  this->eq_sent_mode_ = -1;
  this->eq_pending_mode_ = -1;
  this->priority_suspended_ = false;
  this->priority_gave_up_ = false;
  this->priority_try_count_ = 0;
  this->priority_recheck_at_ = 0;
  this->beep_on_ = -1;
  this->beep_volume_ = -1;
  this->drop_ = Drop::IDLE;
  this->drop_waiting_ = false;
  this->publish_beep_();
  this->publish_eq_bands_();
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
    this->allow_reconnect_();
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
    if (this->drop_ != Drop::IDLE) this->drop_phone_step_();
    if (this->priority_recheck_at_ != 0 && static_cast<int32_t>(now - this->priority_recheck_at_) >= 0) {
      this->priority_recheck_at_ = 0;
      this->enforce_priority_("still not on AUX");
    }
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
  // Read-only Wuzhi queries; the answers come back as pushes.
  if (this->needs_beep_()) this->query_wuzhi_(proto::wuzhi_cmd::BEEP_READ);
#ifdef USE_TEXT_SENSOR
  if (this->firmware_sensor_ != nullptr) this->query_wuzhi_(proto::wuzhi_cmd::MODEL_QUERY);
#endif
  if (this->needs_target_poll_()) this->next_target_poll_at_ = millis() + TARGET_POLL_MS;
}

bool WuzhiAmp::needs_sys_info_() const {
  bool need = false;
#ifdef USE_NUMBER
  need |= this->gain_number_ != nullptr;
#endif
#ifdef USE_SELECT
  need |= this->source_select_ != nullptr;
  need |= this->eq_select_ != nullptr;
#endif
#ifdef USE_SWITCH
  need |= this->aux_priority_switch_ != nullptr;
#endif
#ifdef USE_BINARY_SENSOR
  need |= this->aux_cable_sensor_ != nullptr;
#endif
#ifdef USE_NUMBER
  for (auto *n : this->eq_band_numbers_) need |= n != nullptr;
#endif
  return need;
}

bool WuzhiAmp::needs_target_poll_() const {
  bool need = false;
#ifdef USE_BINARY_SENSOR
  need |= this->bt_audio_sensor_ != nullptr;
#endif
  return need;
}

bool WuzhiAmp::needs_beep_() const {
  bool need = false;
#ifdef USE_SWITCH
  need |= this->beep_switch_ != nullptr;
#endif
#ifdef USE_NUMBER
  need |= this->beep_volume_number_ != nullptr;
#endif
  return need;
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
    if (proto::split_wuzhi(f.payload, cmd, data)) this->on_wuzhi_push_(cmd, data);
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

void WuzhiAmp::query_target_info_now_(std::function<void()> then) {
  ESP_LOGD(TAG, "Sending GetTargetInfo");
  bool sent = this->request_(proto::op::GET_TARGET_INFO, proto::target_info_all_payload(),
                             [this, then](const proto::Frame *reply) {
    if (reply == nullptr || reply->status != 0) {
      if (reply != nullptr) ESP_LOGW(TAG, "GetTargetInfo: status 0x%02x", reply->status);
      if (then) then();
      return;
    }
    proto::TargetInfo info;
    if (!proto::parse_target_info(reply->payload, info)) {
      ESP_LOGW(TAG, "GetTargetInfo: bad TLV list (%u bytes)", static_cast<unsigned>(reply->payload.size()));
      if (then) then();
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
    if (then) then();
  });
  if (!sent && then) then();
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
  if (s.has_eq) this->apply_eq_(s.eq_mode, s.eq_gains);
  if (s.has_volume) {
    this->gain_current_ = s.volume;
    if (this->muted_ && s.volume != 0 && this->gain_target_ < 0) {
      ESP_LOGI(TAG, "Gain changed elsewhere; mute ended");
      this->muted_ = false;
      this->gain_before_mute_ = -1;
      this->publish_mute_();
    }
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
  this->gain_direct_ = false;
  this->gain_target_ = target;  // a new value while stepping just moves the target
  if (this->muted_) {  // a new gain ends the mute
    this->muted_ = false;
    this->gain_before_mute_ = -1;
    this->publish_mute_();
  }
}

void WuzhiAmp::step_gain_() {
  if (this->gain_target_ < 0 || this->gain_in_flight_ || this->gain_current_ < 0) return;
  if (this->gain_target_ == this->gain_current_) {
    this->gain_target_ = -1;
    this->gain_direct_ = false;
    this->publish_gain_();
    return;
  }
  if (this->gain_next_at_ != 0 && static_cast<int32_t>(millis() - this->gain_next_at_) < 0) return;

  // Above the cap (set elsewhere, e.g. the vendor app): go straight down to the cap, since
  // stepping down would send values above it. Down is the safe direction.
  int next = this->gain_current_ > this->max_gain_ ? this->max_gain_
                                                   : proto::next_gain_step(this->gain_current_, this->gain_target_);
  // Mute: lowering is safe, so it goes in one write. Unmute goes up in fast steps of 1.
  if (this->gain_direct_ && this->gain_target_ < this->gain_current_) next = this->gain_target_;
  proto::Bytes payload = proto::set_gain_payload(next, this->max_gain_);
  if (payload.empty()) {  // can't happen with a clamped target; never send it anyway
    ESP_LOGE(TAG, "Refusing gain %d (cap %d)", next, this->max_gain_);
    this->gain_target_ = -1;
    return;
  }
  this->gain_in_flight_ = true;
  bool sent = this->request_(proto::op::SET_SYS_INFO, payload, [this, next](const proto::Frame *reply) {
    this->gain_in_flight_ = false;
    this->gain_next_at_ = millis() + (this->gain_direct_ ? GAIN_FAST_STEP_MS : GAIN_STEP_MS);
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
#ifdef USE_TEXT_SENSOR
  if (t.has_protocol_version && this->protocol_sensor_ != nullptr) {
    char b[8];
    snprintf(b, sizeof b, "%u.%u", t.protocol_version >> 4, t.protocol_version & 0x0f);
    if (this->protocol_published_ != b) {
      this->protocol_published_ = b;
      this->protocol_sensor_->publish_state(b);
    }
  }
#endif
  if (t.has_current_function) this->set_source_(proto::source_from_function(t.current_function), "target info");
}

void WuzhiAmp::set_source_(proto::Source s, const char *why) {
  if (s == this->source_) return;  // the amp repeats the 0x21 push 2-4 times
  ESP_LOGI(TAG, "Source: %s (%s)", proto::source_name(s), why);
  const bool was_known = this->source_ != proto::Source::UNKNOWN;
  this->source_ = s;
  this->publish_source_();
  // A source change often means Bluetooth audio started: worth another EQ try (E1).
  if (this->eq_pending_mode_ >= 0) this->retry_eq_("source changed");
  // AUX priority reacts to changes reported by the amp, not to the first read on connect.
  if (was_known && strcmp(why, "push") == 0 &&
      (s == proto::Source::BLUETOOTH || s == proto::Source::IDLE)) {
    this->enforce_priority_(s == proto::Source::IDLE ? "amp went idle" : "Bluetooth took over");
  }
  // A source change often means Bluetooth audio connected or dropped: re-read it. Not for the
  // first value after connecting, which comes from the reads just made.
  if (was_known && this->needs_target_poll_() && this->link_ == Link::READY) this->query_target_info_now_();
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
  const bool was_known = this->aux_cable_ >= 0;
  this->aux_cable_ = v;
  if (was_known && in) this->enforce_priority_("cable plugged in");
#ifdef USE_BINARY_SENSOR
  if (this->aux_cable_sensor_ != nullptr) this->aux_cable_sensor_->publish_state(in);
#endif
}

void WuzhiAmp::set_bt_audio_(bool on) {
  int v = on ? 1 : 0;
  if (v == this->bt_audio_) return;
  ESP_LOGI(TAG, "Bluetooth audio %s", on ? "connected" : "not connected");
  this->bt_audio_ = v;
  if (on && this->eq_pending_mode_ >= 0) this->retry_eq_("Bluetooth audio connected");
#ifdef USE_BINARY_SENSOR
  if (this->bt_audio_sensor_ != nullptr) this->bt_audio_sensor_->publish_state(on);
#endif
}

void WuzhiAmp::publish_connected_(bool on) {
#ifdef USE_BINARY_SENSOR
  if (this->connected_sensor_ != nullptr) this->connected_sensor_->publish_state(on);
  if (!on) {
    // Amp state is unknown while not connected.
    if (this->aux_cable_sensor_ != nullptr) this->aux_cable_sensor_->invalidate_state();
    if (this->bt_audio_sensor_ != nullptr) this->bt_audio_sensor_->invalidate_state();
  }
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
  // The user's own choice: Bluetooth pauses AUX priority, AUX resumes it (PWA pickSource).
  if (this->aux_priority_ && this->priority_suspended_ != !to_aux) {
    this->priority_suspended_ = !to_aux;
    ESP_LOGI(TAG, "%s", to_aux ? "AUX priority active again" : "AUX priority paused (Bluetooth picked)");
  }
  const proto::Source want = to_aux ? proto::Source::AUX : proto::Source::BLUETOOTH;
  // Switching to Bluetooth while on Bluetooth drops the phone's audio link (S4): skip it.
  if (want == this->source_) {
    this->publish_source_();
    return;
  }
  this->switch_source_(to_aux, "selected");
}

void WuzhiAmp::switch_source_(bool to_aux, const char *why) {
  if (to_aux && this->aux_cable_ != 1) {
    // The amp ignores the switch without a cable (DECISIONS, "From the EQ test").
    ESP_LOGW(TAG, "No AUX cable plugged in; not switching");
    this->publish_source_();
    return;
  }
  if (this->source_in_flight_) return;
  ESP_LOGI(TAG, "Switching to %s (%s)", to_aux ? "AUX" : "Bluetooth", why);
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

// ---------------------------------------------------------------------- EQ ---

void WuzhiAmp::apply_eq_(uint8_t mode, const int8_t gains[10]) {
  const bool gains_changed = memcmp(this->eq_gains_, gains, 10) != 0 || this->eq_mode_ < 0;
  memcpy(this->eq_gains_, gains, 10);
  if (gains_changed) this->publish_eq_bands_();
  // The amp answers an EQ write with the EQ it actually uses; a different mode means refused (E1).
  if (this->eq_sent_mode_ >= 0 && millis() - this->eq_sent_at_ >= EQ_CHECK_MS) this->eq_sent_mode_ = -1;  // stale
  if (this->eq_sent_mode_ >= 0) {
    if (mode != this->eq_sent_mode_) {
      ESP_LOGW(TAG, "The amp refused EQ %s (stays on %s). After power-on it only accepts EQ once it has "
                    "played Bluetooth audio; it will be retried then.",
               proto::eq_name(this->eq_sent_mode_), proto::eq_name(mode));
      this->eq_pending_mode_ = this->eq_sent_mode_;
      memcpy(this->eq_pending_gains_, this->eq_sent_gains_, 10);
    } else {
      ESP_LOGI(TAG, "EQ set to %s", proto::eq_name(mode));
      this->eq_pending_mode_ = -1;
    }
    this->eq_sent_mode_ = -1;
  }
  if (mode != this->eq_mode_) {
    this->eq_mode_ = mode;
    this->publish_eq_();
  }
}

void WuzhiAmp::publish_eq_() {
#ifdef USE_SELECT
  if (this->eq_select_ == nullptr || this->eq_mode_ < 0 || this->eq_mode_ >= proto::EQ_MODE_COUNT) return;
  this->eq_select_->publish_state(static_cast<size_t>(this->eq_mode_));
#endif
}

void WuzhiAmp::request_eq(size_t mode) {
  if (mode >= proto::EQ_MODE_COUNT) return;
  if (this->link_ != Link::READY || this->eq_mode_ < 0) {
    ESP_LOGW(TAG, "EQ change ignored: amp not connected or EQ not known yet");
    this->publish_eq_();
    return;
  }
  if (static_cast<int>(mode) == this->eq_mode_ && this->eq_pending_mode_ < 0) {
    this->publish_eq_();
    return;
  }
  // Presets: the amp fills in its own curve. User: the last gains the amp reported.
  this->write_eq_(static_cast<uint8_t>(mode), this->eq_gains_);
}

void WuzhiAmp::write_eq_(uint8_t mode, const int8_t gains[10]) {
  proto::Bytes payload = proto::set_eq_payload(static_cast<uint8_t>(mode), gains);
  ESP_LOGI(TAG, "EQ %s -> %s", proto::eq_name(this->eq_mode_), proto::eq_name(mode));
  memcpy(this->eq_sent_gains_, gains, 10);
  this->eq_sent_mode_ = static_cast<int>(mode);
  this->eq_sent_at_ = millis();
  this->eq_pending_mode_ = -1;
  this->request_(proto::op::SET_SYS_INFO, payload, [this](const proto::Frame *reply) {
    if (reply == nullptr || reply->status != 0) {
      ESP_LOGW(TAG, "EQ write not confirmed");
      this->eq_sent_mode_ = -1;
    }
    this->publish_eq_();  // the amp's push sets the real value
  });
}

void WuzhiAmp::retry_eq_(const char *why) {
  if (this->eq_pending_mode_ < 0) return;
  if (this->eq_sent_mode_ >= 0 && millis() - this->eq_sent_at_ < EQ_CHECK_MS) return;  // a write is being checked
  ESP_LOGI(TAG, "Retrying EQ %s (%s)", proto::eq_name(this->eq_pending_mode_), why);
  int mode = this->eq_pending_mode_;
  int8_t gains[10];
  memcpy(gains, this->eq_pending_gains_, 10);
  this->eq_pending_mode_ = -1;
  this->write_eq_(static_cast<uint8_t>(mode), gains);
}

// ----------------------------------------------------------- AUX priority ---

void WuzhiAmp::set_aux_priority(bool on) {
  this->aux_priority_ = on;
  this->priority_suspended_ = false;
  this->priority_gave_up_ = false;
  this->priority_try_count_ = 0;
  ESP_LOGI(TAG, "AUX priority %s", on ? "on" : "off");
#ifdef USE_SWITCH
  if (this->aux_priority_switch_ != nullptr) this->aux_priority_switch_->publish_state(on);
#endif
  // Turning it on doesn't switch by itself: it reacts to the next change (like the PWA).
}

// Switch back to AUX when the amp leaves it while a cable is in. A phone connecting often pulls
// the amp back to Bluetooth a moment later, so every attempt is re-checked. At most one try per
// 2 s and 6 per minute, so it can never loop fast. Never disconnects the phone.
void WuzhiAmp::enforce_priority_(const char *why) {
  if (!this->aux_priority_ || this->priority_suspended_ || this->link_ != Link::READY) return;
  if (this->aux_cable_ != 1) return;
  if (this->source_ != proto::Source::BLUETOOTH && this->source_ != proto::Source::IDLE) return;

  const uint32_t now = millis();
  // keep only tries from the last minute
  uint8_t n = 0;
  for (uint8_t i = 0; i < this->priority_try_count_; i++) {
    if (now - this->priority_tries_[i] < 60000) this->priority_tries_[n++] = this->priority_tries_[i];
  }
  this->priority_try_count_ = n;
  if (n >= PRIORITY_MAX_PER_MINUTE) {
    if (!this->priority_gave_up_) {
      ESP_LOGW(TAG, "AUX priority: giving up for a minute (the amp keeps going back to Bluetooth)");
    }
    this->priority_gave_up_ = true;
    this->priority_recheck_at_ = this->priority_tries_[0] + 60000;
    if (this->priority_recheck_at_ == 0) this->priority_recheck_at_ = 1;
    return;
  }
  if (n > 0 && now - this->priority_tries_[n - 1] < PRIORITY_GAP_MS) {
    this->priority_recheck_at_ = this->priority_tries_[n - 1] + PRIORITY_GAP_MS;
    if (this->priority_recheck_at_ == 0) this->priority_recheck_at_ = 1;
    return;
  }
  this->priority_gave_up_ = false;
  this->priority_tries_[this->priority_try_count_++] = now;
  ESP_LOGI(TAG, "AUX priority: back to AUX (%s)", why);
  this->switch_source_(true, "AUX priority");
  this->priority_recheck_at_ = now + PRIORITY_RECHECK_MS;
  if (this->priority_recheck_at_ == 0) this->priority_recheck_at_ = 1;
}

// --------------------------------------------------------------- auto-find ---

static bool starts_with_ci(const char *s, const std::string &prefix) {
  for (size_t i = 0; i < prefix.size(); i++) {
    if (s[i] == '\0' || tolower(static_cast<unsigned char>(s[i])) != tolower(static_cast<unsigned char>(prefix[i])))
      return false;
  }
  return true;
}

bool WuzhiAmp::parse_device(const espbt::ESPBTDevice &device) {
  if (this->configured_address_ != 0 || this->adopted_address_ != 0) return false;
  StringRef ref = device.get_name();
  if (ref.empty()) return false;
  const std::string name(ref.c_str(), ref.size());  // not NUL-terminated
  if (!starts_with_ci(name.c_str(), this->name_prefix_)) return false;
  uint64_t addr = device.address_uint64();
  this->adopted_address_ = addr;
  this->address_pref_.save(&addr);
  global_preferences->sync();
  this->parent()->set_address(addr);
  if (this->log_private_) {
    ESP_LOGI(TAG, "Found amp \"%s\" at %s, RSSI %d; stored", name.c_str(), this->parent()->address_str(),
             device.get_rssi());
  } else {
    ESP_LOGI(TAG, "Found amp \"%s\", RSSI %d; stored (address not logged)", name.c_str(), device.get_rssi());
  }
  return false;  // ble_client connects on its next sighting
}

void WuzhiAmp::forget_amp() {
  if (this->configured_address_ != 0) {
    ESP_LOGW(TAG, "Forget amp: the address is set in the config, nothing to forget");
    return;
  }
  ESP_LOGI(TAG, "Forgetting the stored amp; adopting the next one found");
  uint64_t zero = 0;
  this->address_pref_.save(&zero);
  global_preferences->sync();
  this->adopted_address_ = 0;
  this->backoff_ms_ = 0;
  this->reconnect_at_ = 0;
  this->allow_reconnect_();
  if (this->link_ != Link::DISCONNECTED || this->parent()->state() != espbt::ClientState::IDLE) {
    this->parent()->disconnect();
  }
  this->parent()->set_address(0);
}

void WuzhiAmp::publish_eq_bands_() {
#ifdef USE_NUMBER
  for (int i = 0; i < 10; i++) {
    if (this->eq_band_numbers_[i] == nullptr) continue;
    this->eq_band_numbers_[i]->publish_state(this->eq_mode_ < 0 && this->link_ != Link::READY
                                                 ? NAN
                                                 : static_cast<float>(this->eq_gains_[i]));
  }
#endif
}

void WuzhiAmp::request_eq_band(int band, float db) {
  if (band < 0 || band > 9 || std::isnan(db)) return;
  if (this->link_ != Link::READY || this->eq_mode_ < 0) {
    ESP_LOGW(TAG, "EQ change ignored: amp not connected or EQ not known yet");
    this->publish_eq_bands_();
    return;
  }
  int v = static_cast<int>(std::lround(db));
  if (v > proto::EQ_GAIN_LIMIT) v = proto::EQ_GAIN_LIMIT;
  if (v < -proto::EQ_GAIN_LIMIT) v = -proto::EQ_GAIN_LIMIT;
  int8_t gains[10];
  memcpy(gains, this->eq_gains_, 10);
  gains[band] = static_cast<int8_t>(v);
  // Band gains only apply to the User EQ; changing one switches to it (as in the PWA).
  this->write_eq_(proto::EQ_MODE_USER, gains);
}

// ------------------------------------------------------------------- beep ---

void WuzhiAmp::query_wuzhi_(uint8_t cmd) {
  this->request_(proto::op::CUSTOM, proto::wuzhi_frame(cmd), [cmd](const proto::Frame *reply) {
    if (reply != nullptr && reply->status != 0) ESP_LOGW(TAG, "Wuzhi query 0x%02x: status 0x%02x", cmd, reply->status);
  });
}

void WuzhiAmp::on_wuzhi_push_(uint8_t cmd, const proto::Bytes &data) {
  if (cmd == proto::wuzhi_cmd::SOURCE_PUSH && data.size() == 1) {
    this->set_source_(proto::source_from_push(data[0]), "push");
  } else if (cmd == proto::wuzhi_cmd::BEEP_READ && data.size() == 2) {
    this->beep_on_ = data[0] ? 1 : 0;
    this->beep_volume_ = data[1];
    ESP_LOGI(TAG, "Beep %s, volume %d", this->beep_on_ ? "on" : "off", this->beep_volume_);
    this->publish_beep_();
  } else if (cmd == proto::wuzhi_cmd::MODEL_QUERY) {
    proto::ModelInfo m;
    if (proto::parse_model_reply(data, m)) {
      ESP_LOGI(TAG, "Model: product %s, firmware %s, build %s", m.product.c_str(), m.firmware().c_str(),
               m.build.c_str());
#ifdef USE_TEXT_SENSOR
      if (this->firmware_sensor_ != nullptr) this->firmware_sensor_->publish_state(m.firmware());
#endif
    }
  }
}

void WuzhiAmp::publish_beep_() {
#ifdef USE_SWITCH
  if (this->beep_switch_ != nullptr && this->beep_on_ >= 0) this->beep_switch_->publish_state(this->beep_on_ == 1);
#endif
#ifdef USE_NUMBER
  if (this->beep_volume_number_ != nullptr) {
    this->beep_volume_number_->publish_state(this->beep_volume_ < 0 ? NAN : static_cast<float>(this->beep_volume_));
  }
#endif
}

void WuzhiAmp::request_beep(int on, int volume) {
  if (this->link_ != Link::READY || this->beep_on_ < 0 || this->beep_volume_ < 0) {
    ESP_LOGW(TAG, "Beep change ignored: amp not connected or beep not known yet");
    this->publish_beep_();
    return;
  }
  const int new_on = on < 0 ? this->beep_on_ : on;
  int new_vol = volume < 0 ? this->beep_volume_ : volume;
  const int limit = std::min(this->max_gain_, proto::BEEP_VOLUME_MAX);
  if (new_vol > limit) {
    ESP_LOGW(TAG, "Beep volume %d is above the limit %d, using %d", new_vol, limit, limit);
    new_vol = limit;
  }
  proto::Bytes frame = proto::beep_set_frame(new_on == 1, new_vol, this->max_gain_);
  if (frame.empty()) {
    this->publish_beep_();
    return;
  }
  ESP_LOGI(TAG, "Beep %s, volume %d", new_on ? "on" : "off", new_vol);
  this->request_(proto::op::CUSTOM, frame, [this, new_on, new_vol](const proto::Frame *reply) {
    if (reply != nullptr && reply->status == 0) {
      // The amp only acknowledges (AA 02 02 80 55); take the values as sent, like the PWA.
      this->beep_on_ = new_on;
      this->beep_volume_ = new_vol;
    } else {
      ESP_LOGW(TAG, "Beep change not confirmed");
    }
    this->publish_beep_();
  });
}

// -------------------------------------------------- disconnect phone audio ---
// Port of dropPhone() in src/app/amp.ts: re-read Bluetooth audio; if a phone is connected
// and the amp isn't on Bluetooth, switch to Bluetooth first (the command only works there);
// send opcode 0x06; then check up to 4 times, 750 ms apart. The amp returns to AUX by itself
// if a cable is in, and AUX priority gets a chance afterwards.

void WuzhiAmp::disconnect_phone() {
  if (this->link_ != Link::READY || this->drop_ != Drop::IDLE) {
    ESP_LOGW(TAG, "Disconnect phone audio ignored: amp not connected or already running");
    return;
  }
  this->drop_ = Drop::READ;
  this->drop_waiting_ = true;
  this->query_target_info_now_([this]() { this->drop_waiting_ = false; });
}

void WuzhiAmp::drop_phone_step_() {
  if (this->drop_waiting_) return;
  const uint32_t now = millis();
  switch (this->drop_) {
    case Drop::READ:
      if (this->bt_audio_ != 1) {
        ESP_LOGW(TAG, "No phone or computer is connected for audio");
        this->drop_ = Drop::IDLE;
        return;
      }
      if (this->source_ != proto::Source::BLUETOOTH) {
        this->switch_source_(false, "to disconnect the phone");
        this->drop_ = Drop::TO_BLUETOOTH;
        this->drop_deadline_ = now + 2000;
        return;
      }
      this->drop_ = Drop::SEND;
      return;
    case Drop::TO_BLUETOOTH:
      if (this->source_ == proto::Source::BLUETOOTH || static_cast<int32_t>(now - this->drop_deadline_) >= 0) {
        this->drop_ = Drop::SEND;
      }
      return;
    case Drop::SEND:
      ESP_LOGI(TAG, "Disconnecting Bluetooth audio");
      this->drop_ = Drop::VERIFY;
      this->drop_checks_ = 0;
      this->drop_waiting_ = true;
      if (!this->request_(proto::op::DISCONNECT_CLASSIC, proto::Bytes{}, [this](const proto::Frame *reply) {
            this->drop_waiting_ = false;
            this->drop_deadline_ = millis() + 750;
            if (reply == nullptr || reply->status != 0) ESP_LOGW(TAG, "Disconnect command not confirmed");
          })) {
        this->drop_ = Drop::IDLE;
        this->drop_waiting_ = false;
      }
      return;
    case Drop::VERIFY:
      if (static_cast<int32_t>(now - this->drop_deadline_) < 0) return;
      if (this->bt_audio_ == 0) {
        ESP_LOGI(TAG, "Bluetooth audio disconnected");
        this->drop_ = Drop::IDLE;
        this->enforce_priority_("after disconnecting the phone");
        return;
      }
      if (this->drop_checks_ >= 4) {
        ESP_LOGW(TAG, "Asked the amp to disconnect Bluetooth audio, but it is still connected");
        this->drop_ = Drop::IDLE;
        return;
      }
      this->drop_checks_++;
      this->drop_waiting_ = true;
      this->query_target_info_now_([this]() {
        this->drop_waiting_ = false;
        this->drop_deadline_ = millis() + 750;
      });
      return;
    default:
      return;
  }
}

// --------------------------------------------------------------- mute ---

void WuzhiAmp::publish_mute_() {
#ifdef USE_SWITCH
  if (this->mute_switch_ != nullptr) this->mute_switch_->publish_state(this->muted_);
#endif
}

void WuzhiAmp::set_mute(bool on) {
  if (on == this->muted_) {
    this->publish_mute_();
    return;
  }
  if (this->link_ != Link::READY || this->gain_current_ < 0) {
    ESP_LOGW(TAG, "Mute ignored: amp not connected or gain not known yet");
    this->publish_mute_();
    return;
  }
  if (on) {
    // Remember where it was (or where it was heading).
    this->gain_before_mute_ = this->gain_target_ >= 0 ? this->gain_target_ : this->gain_current_;
    this->muted_ = true;
    ESP_LOGI(TAG, "Mute (gain %d -> 0)", this->gain_before_mute_);
    this->gain_target_ = 0;
    this->gain_direct_ = true;
  } else {
    int back = this->gain_before_mute_ < 0 ? 0 : this->gain_before_mute_;
    if (back > this->max_gain_) back = this->max_gain_;
    this->muted_ = false;
    this->gain_before_mute_ = -1;
    ESP_LOGI(TAG, "Unmute (gain -> %d, fast steps)", back);
    this->gain_direct_ = true;
    this->gain_target_ = back;
  }
  this->publish_mute_();
}

// -------------------------------------------------------- connect switch ---

void WuzhiAmp::allow_reconnect_() {
  if (this->connect_enabled_) this->parent()->set_auto_connect(true);
}

void WuzhiAmp::set_connect_enabled(bool on) {
  this->connect_enabled_ = on;
#ifdef USE_SWITCH
  if (this->connect_switch_ != nullptr) this->connect_switch_->publish_state(on);
#endif
  if (on) {
    ESP_LOGI(TAG, "Connect to amp: on");
    this->backoff_ms_ = 0;
    this->reconnect_at_ = 0;
    this->parent()->set_auto_connect(true);
  } else {
    ESP_LOGI(TAG, "Connect to amp: off, disconnecting and staying disconnected");
    this->reconnect_at_ = 0;
    this->parent()->set_auto_connect(false);
    if (this->link_ != Link::DISCONNECTED || this->parent()->state() != espbt::ClientState::IDLE) {
      this->parent()->disconnect();
    }
  }
}

}  // namespace wuzhi_amp
}  // namespace esphome

#endif  // USE_ESP32

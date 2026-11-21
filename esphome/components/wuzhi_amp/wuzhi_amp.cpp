#include "wuzhi_amp.h"

#ifdef USE_ESP32

#include <esp_gattc_api.h>

#include <algorithm>
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
static const uint8_t AUTH_MAX_ATTEMPTS = 3;         // spec §4: up to 3 attempts
static const uint32_t CCCD_FALLBACK_MS = 1000;

void WuzhiAmp::setup() {}

void WuzhiAmp::dump_config() {
  ESP_LOGCONFIG(TAG, "Wuzhi amp bridge:");
  ESP_LOGCONFIG(TAG, "  Query target info on connect: %s", YESNO(this->query_target_info_));
  ESP_LOGCONFIG(TAG, "  Log private identifiers: %s", YESNO(this->log_private_));
}

void WuzhiAmp::reset_link_() {
  this->link_ = Link::DISCONNECTED;
  this->write_handle_ = 0;
  this->notify_handle_ = 0;
  this->auth_ = proto::AuthSession();
  this->auth_attempt_ = 0;
  this->auth_step_deadline_ = 0;
  this->cccd_fallback_at_ = 0;
  this->reassembler_.reset();
  this->sn_ = 0;
  this->pending_.clear();
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
      // ble_client marks every node ESTABLISHED at SEARCH_CMPL and then frees its GATT cache once
      // all nodes are established and no counted notify registration is pending. The CCCD lookup
      // needs that cache, so: stay CONNECTED until notifications are on, and register through
      // the client so the registration is counted.
      this->node_state = espbt::ClientState::CONNECTED;
      auto err = this->parent()->register_for_notify(nt->handle);
      if (err != ESP_OK) {
        ESP_LOGE(TAG, "register_for_notify failed: %d", err);
        break;
      }
      this->link_ = Link::DISCOVERED;
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
      this->start_auth_();
      break;

    case ESP_GATTC_NOTIFY_EVT:
      if (param->notify.handle != this->notify_handle_) break;
      if (this->link_ == Link::AUTHENTICATING) {
        ESP_LOGD(TAG, "auth rx %u bytes", static_cast<unsigned>(param->notify.value_len));
      }
      this->on_notify_(param->notify.value, param->notify.value_len);
      break;

    default:
      break;
  }
}

void WuzhiAmp::loop() {
  const uint32_t now = millis();

  if (this->link_ == Link::DISCOVERED && this->cccd_fallback_at_ != 0 &&
      static_cast<int32_t>(now - this->cccd_fallback_at_) >= 0) {
    ESP_LOGW(TAG, "No confirmation for enabling notifications, starting auth anyway");
    this->node_state = espbt::ClientState::ESTABLISHED;
    this->cccd_fallback_at_ = 0;
    this->start_auth_();
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

void WuzhiAmp::start_auth_() {
  if (this->auth_attempt_ >= AUTH_MAX_ATTEMPTS) {
    ESP_LOGE(TAG, "auth failed after %u attempts, disconnecting (ble_client will retry)", this->auth_attempt_);
    this->auth_step_deadline_ = 0;
    this->link_ = Link::DISCOVERED;
    this->parent()->disconnect();
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

void WuzhiAmp::on_authenticated_() {
  ESP_LOGI(TAG, "Authenticated with amp");
  this->link_ = Link::READY;
  this->reassembler_.reset();
  if (this->query_target_info_) this->query_target_info_now_();
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

  // Device push. Decoding of 0x21 (source) and 0x09 (SysInfo) comes in the next milestone.
  ESP_LOGD(TAG, "Push: opcode 0x%02x, %u payload bytes: %s", f.opcode, static_cast<unsigned>(f.payload.size()),
           proto::to_hex(f.payload).c_str());
  if (f.expects_response) this->write_(proto::ack_for(f));  // bare ack (D6), as the PWA does
}

bool WuzhiAmp::write_(const proto::Bytes &bytes) {
  if (this->write_handle_ == 0) return false;
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
    ESP_LOGI(TAG, "Target info: %s", proto::describe_target_info(info).c_str());
    for (const auto &line : proto::describe_tlvs(info, this->log_private_)) ESP_LOGI(TAG, "  %s", line.c_str());
  });
}

}  // namespace wuzhi_amp
}  // namespace esphome

#endif  // USE_ESP32

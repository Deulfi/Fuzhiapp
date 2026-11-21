"""Forget amp and Disconnect phone audio as Home Assistant buttons."""

import esphome.codegen as cg
from esphome.components import button
import esphome.config_validation as cv
from esphome.const import ENTITY_CATEGORY_CONFIG

from . import CONF_WUZHI_AMP_ID, WuzhiAmp, wuzhi_amp_ns

DEPENDENCIES = ["wuzhi_amp"]

CONF_FORGET_AMP = "forget_amp"
CONF_DISCONNECT_PHONE = "disconnect_phone"

ForgetAmpButton = wuzhi_amp_ns.class_("ForgetAmpButton", button.Button)
DisconnectPhoneButton = wuzhi_amp_ns.class_("DisconnectPhoneButton", button.Button)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_WUZHI_AMP_ID): cv.use_id(WuzhiAmp),
        # Drops the stored amp; the next amp found by name is adopted. Only with
        # ble_client mac_address 00:00:00:00:00:00.
        cv.Optional(CONF_FORGET_AMP): button.button_schema(
            ForgetAmpButton,
            icon="mdi:link-variant-off",
            entity_category=ENTITY_CATEGORY_CONFIG,
        ),
        # Drops the phone's or computer's Bluetooth audio link (switches to Bluetooth
        # first if needed). The amp goes back to AUX by itself when a cable is in.
        cv.Optional(CONF_DISCONNECT_PHONE): button.button_schema(
            DisconnectPhoneButton, icon="mdi:bluetooth-off"
        ),
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if conf := config.get(CONF_FORGET_AMP):
        b = await button.new_button(conf)
        await cg.register_parented(b, amp)
    if conf := config.get(CONF_DISCONNECT_PHONE):
        b = await button.new_button(conf)
        await cg.register_parented(b, amp)

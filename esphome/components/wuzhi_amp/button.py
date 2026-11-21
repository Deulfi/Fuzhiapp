"""Forget amp as a Home Assistant button."""

import esphome.codegen as cg
from esphome.components import button
import esphome.config_validation as cv
from esphome.const import ENTITY_CATEGORY_CONFIG

from . import CONF_WUZHI_AMP_ID, WuzhiAmp, wuzhi_amp_ns

DEPENDENCIES = ["wuzhi_amp"]

CONF_FORGET_AMP = "forget_amp"

ForgetAmpButton = wuzhi_amp_ns.class_("ForgetAmpButton", button.Button)

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
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if conf := config.get(CONF_FORGET_AMP):
        b = await button.new_button(conf)
        await cg.register_parented(b, amp)

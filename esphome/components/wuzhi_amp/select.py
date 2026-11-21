"""Source (Bluetooth / AUX) as a Home Assistant select."""

import esphome.codegen as cg
from esphome.components import select
import esphome.config_validation as cv

from . import CONF_WUZHI_AMP_ID, WuzhiAmp, wuzhi_amp_ns

DEPENDENCIES = ["wuzhi_amp"]

CONF_SOURCE = "source"
# Order matters: the C++ side uses the index (0 Bluetooth, 1 AUX, 2 Idle).
SOURCE_OPTIONS = ["Bluetooth", "AUX", "Idle"]

SourceSelect = wuzhi_amp_ns.class_("SourceSelect", select.Select)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_WUZHI_AMP_ID): cv.use_id(WuzhiAmp),
        cv.Optional(CONF_SOURCE): select.select_schema(
            SourceSelect, icon="mdi:import"
        ),
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if source := config.get(CONF_SOURCE):
        s = await select.new_select(source, options=SOURCE_OPTIONS)
        await cg.register_parented(s, amp)
        cg.add(amp.set_source_select(s))

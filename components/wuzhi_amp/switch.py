"""AUX priority and beep as Home Assistant switches."""

import esphome.codegen as cg
from esphome.components import switch
import esphome.config_validation as cv
from esphome.const import ENTITY_CATEGORY_CONFIG

from . import CONF_WUZHI_AMP_ID, WuzhiAmp, wuzhi_amp_ns

DEPENDENCIES = ["wuzhi_amp"]

CONF_AUX_PRIORITY = "aux_priority"
CONF_BEEP = "beep"

AuxPrioritySwitch = wuzhi_amp_ns.class_("AuxPrioritySwitch", switch.Switch)
BeepSwitch = wuzhi_amp_ns.class_("BeepSwitch", switch.Switch)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(CONF_WUZHI_AMP_ID): cv.use_id(WuzhiAmp),
        # Switch back to AUX when the amp leaves it while a cable is in. Off by default;
        # the setting is kept across reboots.
        cv.Optional(CONF_AUX_PRIORITY): switch.switch_schema(
            AuxPrioritySwitch,
            default_restore_mode="RESTORE_DEFAULT_OFF",
            icon="mdi:priority-high",
        ),
        # The amp's beep (prompt tones). State comes from the amp, nothing is restored.
        cv.Optional(CONF_BEEP): switch.switch_schema(
            BeepSwitch, icon="mdi:bell-ring", entity_category=ENTITY_CATEGORY_CONFIG
        ),
    }
)


async def to_code(config):
    amp = await cg.get_variable(config[CONF_WUZHI_AMP_ID])
    if conf := config.get(CONF_AUX_PRIORITY):
        sw = await switch.new_switch(conf)
        await cg.register_parented(sw, amp)
        cg.add(amp.set_aux_priority_switch(sw))
    if conf := config.get(CONF_BEEP):
        sw = await switch.new_switch(conf)
        await cg.register_parented(sw, amp)
        cg.add(amp.set_beep_switch(sw))

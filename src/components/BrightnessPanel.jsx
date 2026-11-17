import React, { memo, useEffect, useMemo, useState } from "react";
import Slider from "./Slider";
import DDCCISliders from "./DDCCISliders"
import HDRSliders from "./HDRSliders";
import TranslateReact from "../TranslateReact"
import getMonitorName from "../utils/BrightnessPanel/getMonitorName";
import { usesGammaSlider, isAdjustableDisplay } from "./utilts/monitor.util";

const BrightnessPanel = memo(function BrightnessPanel() {

  const [state, setState] = useState({
    // The preload may receive monitor data before this component registers
    // its event listener, so begin with the latest available snapshot.
    monitors: window.allMonitors || {},
    hideDisplays: window.settings?.hideDisplays || {},
    linkedLevelsActive: false,
    names: {},
    update: false,
    sleeping: false,
    updateProgress: 0,
    isRefreshing: window.isRefreshing
  })
  const [T] = useState(new TranslateReact({}, {}))
  const [, setLocalizationVersion] = useState(0)

  const numMonitors = useMemo(() => {
    let localNumMonitors = 0
    for (let key in state.monitors) {
      if ((isAdjustableDisplay(state.monitors[key]) || state.monitors[key].hdr === "active") && !(state.hideDisplays?.[key] === true)) localNumMonitors++;
    }
    return localNumMonitors
  }, [state.monitors, state.hideDisplays])

  let panelHeight = -1

  // Enable/Disable linked levels
  const toggleLinkedLevels = () => {
    const linkedLevelsActive = (state.linkedLevelsActive ? false : true)
    setState(prev => ({ ...prev, linkedLevelsActive }))
    window.sendSettings({
      linkedLevelsActive
    })
  }

  // Send intent immediately; the main process throttles writes per monitor.
  const handleChange = (level, slider) => {
    if (!numMonitors) return

    const monitors = { ...state.monitors }
    const targetKeys = state.linkedLevelsActive ? Object.keys(monitors) : [slider.props.hwid]
    window.pauseMonitorUpdates()
    for (const key of targetKeys) {
      const monitor = monitors[key]
      if (!monitor || !isAdjustableDisplay(monitor) || state.hideDisplays?.[key]) continue
      monitors[key] = { ...monitor, brightness: level }
      window.updateBrightness(monitor.id, level)
    }
    setState(prev => ({ ...prev, monitors }))
  }

  // Update monitor info
  const recievedMonitors = (e) => {
    let newMonitors = { ...e.detail }
    // Reset panel height so it's recalculated
    panelHeight = -1
    setState(prev => ({
      ...prev,
      monitors: newMonitors
    }))
  }

  // Update settings
  const recievedSettings = (e) => {
    const settings = e.detail
    const linkedLevelsActive = (settings.linkedLevelsActive ?? false)
    const sleepAction = (settings.sleepAction ?? "none")
    const names = (settings.names || {})
    const hideDisplays = (settings.hideDisplays || {})
    setState(prev => ({
      ...prev,
      linkedLevelsActive,
      names,
      hideDisplays,
      sleepAction
    }))
  }

  const recievedUpdate = (e) => {
    const update = e.detail
    setState(prev => ({ ...prev, update }))
  }

  const recievedSleep = (e) => {
    setState(prev => ({ ...prev, sleeping: e.detail }))
  }



  const handleIsRefreshingUpdate = (e) => setState(prev => ({ ...prev, isRefreshing: e.detail }))
  const handleUpdateProgress = (e) => setState(prev => ({ ...prev, updateProgress: e.detail.progress }))

  useEffect(() => {
    const handleMonitorsUpdated = (e) => recievedMonitors(e)
    const handleSettingsUpdated = (e) => recievedSettings(e)
    const handleLocalizationUpdated = (e) => {
      T.setLocalizationData(e.detail.desired, e.detail.default)
      setLocalizationVersion(version => version + 1)
    }
    const handleUpdateUpdated = (e) => recievedUpdate(e)
    const handleSleepUpdated = (e) => recievedSleep(e)
    const handleRefreshingUpdated = (e) => handleIsRefreshingUpdate(e)
    const handleProgressUpdated = (e) => handleUpdateProgress(e)

    window.addEventListener("monitorsUpdated", handleMonitorsUpdated)
    window.addEventListener("settingsUpdated", handleSettingsUpdated)
    window.addEventListener("localizationUpdated", handleLocalizationUpdated)
    window.addEventListener("updateUpdated", handleUpdateUpdated)
    window.addEventListener("sleepUpdated", handleSleepUpdated)
    window.addEventListener("isRefreshing", handleRefreshingUpdated)

    if (window.isAppX === false) {
      window.addEventListener("updateProgress", handleProgressUpdated)
    }

    // Request the initial settings and monitor state
    window.requestSettings()
    window.requestMonitors()
    window.ipc.send('request-localization')
    window.reactReady = true

    return () => {
      window.removeEventListener("monitorsUpdated", handleMonitorsUpdated)
      window.removeEventListener("settingsUpdated", handleSettingsUpdated)
      window.removeEventListener("localizationUpdated", handleLocalizationUpdated)
      window.removeEventListener("updateUpdated", handleUpdateUpdated)
      window.removeEventListener("sleepUpdated", handleSleepUpdated)
      window.removeEventListener("isRefreshing", handleRefreshingUpdated)
      window.removeEventListener("updateProgress", handleProgressUpdated)
    }
  }, [])

  useEffect(() => {
    const height = window.document.getElementById("panel").offsetHeight
    if (panelHeight != height) {
      panelHeight = height
      window.sendHeight(height)
    }
  })

  const getMonitors = () => {
    if (!state.monitors || numMonitors == 0) {
      if (state.isRefreshing) {
        return (<div className="no-displays-message" style={{ textAlign: "center", paddingBottom: "15px" }}>{T.t("GENERIC_DETECTING_DISPLAYS")}</div>)
      }
      return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>)
    } else {
      if (state.linkedLevelsActive) {
        // Combine all monitors
        let lastValidMonitor
        for(const key in state.monitors) {
          const monitor = state.monitors[key]
          if(monitor.type == "wmi" || monitor.type == "studio-display" || monitor.type == "software" || (monitor.type == "ddcci" && monitor.brightnessType) || monitor.hdr === "active" || usesGammaSlider(monitor)) {
           lastValidMonitor = monitor 
          }
        }
        if (lastValidMonitor) {
          const monitor = lastValidMonitor
          return (
            <Slider name={T.t("GENERIC_ALL_DISPLAYS")} id={monitor.id} level={monitor.brightness} min={0} max={100} num={monitor.num} monitortype={monitor.type} hwid={monitor.key} key={monitor.key} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} />
          )
        }
        return (<div className="no-displays-message">{T.t("GENERIC_NO_COMPATIBLE_DISPLAYS")}</div>)
      } else {
        // Show all valid monitors individually
        const sorted = Object.values(state.monitors).slice(0).sort((a, b) => {
          const aSort = (a.order === undefined ? 999 : a.order * 1)
          const bSort = (b.order === undefined ? 999 : b.order * 1)
          return aSort - bSort
        })
        let useFeatures = false
        // Check if we should use the extended DDC/CI layout or simple layout
        for (const { hwid } of sorted) {
          const monitorFeatures = window.settings?.monitorFeatures?.[hwid[1]]
          for (const vcp in monitorFeatures) {
            if (vcp == "0x10" || vcp == "0x13" || vcp == "0xD6") {
              continue; // Skip if brightness or power state
            }
            const feature = monitorFeatures[vcp]
            if (feature) {
              // Feature is active
              // Now we check if there are any settings active for the feature
              const featureSettings = window.settings.monitorFeaturesSettings?.[hwid[1]]
              if (!(featureSettings?.[vcp]?.linked)) {
                // Isn't linked
                useFeatures = true
              }
            }
          }
        }

        return sorted.map((monitor) => {
          if ((!isAdjustableDisplay(monitor) && monitor.hdr !== "active") || window.settings?.hideDisplays?.[monitor.key] === true) {
            return (<div key={monitor.key}></div>)
          } else {
            if (monitor.type == "wmi" || monitor.type == "studio-display" || monitor.type == "software" || (monitor.type == "ddcci" && monitor.brightnessType) || monitor.hdr === "active" || usesGammaSlider(monitor)) {

              let hasFeatures = true
              let featureCount = 0
              const monitorFeatures = window.settings?.monitorFeatures?.[monitor.hwid[1]]
              const features = ["0x12", "0xD6", "0x62"]
              if (monitor.features) {
                features.forEach(f => {
                  // Check monitor features
                  if (monitor.features[f] && monitor.features[f].length > 1) {
                    // Check that user has enabled feature
                    if (monitorFeatures && monitorFeatures[f]) {
                      // Track feature
                      hasFeatures = true
                      featureCount++
                    }
                  }
                })
              }
              let showHDRSliders = false
              if((monitor.hdr === "active" || window.settings?.hdrDisplays?.[monitor.key]) && !(window.settings?.sdrAsMainSliderDisplays?.[monitor.key])) {
                // Has HDR slider enabled
                hasFeatures = true
                useFeatures = true
                showHDRSliders = true
              }
              const powerOff = () => {
                window.ipc.send("sleep-display", monitor.hwid.join("#"))
                monitor.features["0xD6"][0] = (monitor.features["0xD6"][0] >= 4 ? 1 : settings.ddcPowerOffValue)
              }
              const showPowerButton = () => {
                const customFeatureEnabled = window.settings?.monitorFeaturesSettings?.[monitor?.hwid[1]]?.["0xD6"]
                if (monitorFeatures?.["0xD6"] && (monitor.features?.["0xD6"] || customFeatureEnabled)) {
                  return (<div className="feature-power-icon simple" onClick={powerOff}><span className="icon vfix">&#xE7E8;</span><span>{(monitor.features?.["0xD6"][0] >= 4 ? T.t("PANEL_LABEL_TURN_ON") : T.t("PANEL_LABEL_TURN_OFF"))}</span></div>)
                }
              }

              // Check if it's an HDR display and only supports SDR brightness adjustment.
              const isHDROnlySDR = (monitor.hdr === "active" || monitor.hdr === "supported") && monitor.type === "none" && !usesGammaSlider(monitor);
              
              if (!useFeatures || !hasFeatures) {
                // For HDR displays that only support SDR, the HDR slider is displayed directly instead of the regular brightness slider.
                if (isHDROnlySDR) {
                  return (
                    <div className="monitor-sliders extended" key={monitor.key}>
                      <div className="monitor-item" style={{ height: "auto", paddingBottom: "18px" }}>
                        <div className="name-row">
                          <div className="icon"><span>&#xE7F4;</span></div>
                          <div className="title">{getMonitorName(monitor, state.names)}</div>
                          { showPowerButton() }
                        </div>
                      </div>
                      <HDRSliders monitor={monitor} scrollAmount={window.settings?.scrollFlyoutAmount} />
                    </div>
                  )
                }
                return (
                  <div className="monitor-sliders" key={monitor.key}>
                    <Slider name={getMonitorName(monitor, state.names)} id={monitor.id} level={monitor.brightness} min={0} max={100} num={monitor.num} monitortype={monitor.type} hwid={monitor.key} key={monitor.key} onChange={handleChange} afterName={showPowerButton()} scrollAmount={window.settings?.scrollFlyoutAmount} />
                  </div>
                )
              } else {
                return (
                  <div className="monitor-sliders extended" key={monitor.key}>
                    <div className="monitor-item" style={{ height: "auto", paddingBottom: "18px" }}>
                      <div className="name-row">
                        <div className="icon">{(monitor.type == "wmi" ? <span>&#xE770;</span> : <span>&#xE7F4;</span>)}</div>
                        <div className="title">{getMonitorName(monitor, state.names)}</div>
                        {showPowerButton()}
                      </div>
                    </div>
                    {/* For HDR displays that only support SDR, hide the regular brightness slider. */}
                    { !isHDROnlySDR && (
                      <div className="feature-row feature-brightness">
                        <div className="feature-icon"><span className="icon vfix">&#xE706;</span></div>
                        <Slider id={monitor.id} level={monitor.brightness} min={0} max={100} num={monitor.num} monitortype={monitor.type} hwid={monitor.key} key={monitor.key} onChange={handleChange} scrollAmount={window.settings?.scrollFlyoutAmount} />
                      </div>
                    )}
                    <DDCCISliders monitor={monitor} monitorFeatures={monitorFeatures} scrollAmount={window.settings?.scrollFlyoutAmount} />
                    {showHDRSliders ? <HDRSliders monitor={monitor} scrollAmount={window.settings?.scrollFlyoutAmount} /> : null}
                  </div>
                )
              }
            }
          }
        })
      }
    }
  }

  return (
    <div className="window-base" data-theme={window.settings.theme || "default"} id="panel" data-refreshing={state.isRefreshing}>
      <div className="titlebar">
        <div className="title">{T.t("PANEL_TITLE")}</div>
        <div className="icons">
          {
            numMonitors > 1 &&
            <div
              title={T.t("PANEL_BUTTON_LINK_LEVELS")}
              data-active={state.linkedLevelsActive}
              onClick={toggleLinkedLevels}
              className="link">
              &#xE71B;
            </div>
          }
          {
            window.settings.sleepAction !== "none" &&
            <div
              title={T.t("PANEL_BUTTON_TURN_OFF_DISPLAYS")}
              className="off"
              onClick={window.turnOffDisplays}>
              &#xF71D;
            </div>
          }
          <div title={T.t("GENERIC_SETTINGS")} className="settings" onClick={window.openSettings}>&#xE713;</div>
        </div>
      </div>
      {state.sleeping ? (<div></div>) : getMonitors()}
      {
        (state.update && state.update.show)
          ?
          <div className="updateBar">
            <div className="left">
              {T.t("PANEL_UPDATE_AVAILABLE")}
              ({state.update.version})
            </div>
            <div className="right">
              <a onClick={window.installUpdate}>
                {T.t("GENERIC_INSTALL")}
              </a>
              <a className="icon" title={T.t("GENERIC_DISMISS")} onClick={window.dismissUpdate}>
                &#xEF2C;
              </a>
            </div>
          </div>
          :
          (state.update && state.update.downloading)
          &&
          <div className="updateBar">
            <div className="left progress">
              <div className="progress-bar">
                <div style={{ width: `${state.updateProgress}%` }}>
                </div>
              </div>
            </div>
            <div className="right">
              {state.updateProgress}%
            </div>
          </div>
      }
      <div id="mica">
        <div className="displays" style={{ visibility: window.micaState.visibility }}>
          <div className="blur">
            <img alt="" src={window.micaState.src} width="2560" height="1440" />
          </div>
        </div>
        <div className="noise"></div>
      </div>
    </div>
  )
})

export default BrightnessPanel

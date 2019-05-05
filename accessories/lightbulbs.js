const colorConvert = require('color-convert')

const { handleFailedRequest } = require('../error-handlers')

const getHueSaturation = (colorMode, red, green, blue, white = 0) => {
  const hsv = colorConvert.rgb.hsv(red, green, blue)
  const hue = hsv[0]
  const saturation = colorMode === 'rgbw'
    // in rgbw mode we use the white component as the saturation, otherwise we
    // calculate it from the red, green and blue components
    ? 100 - Math.round(white / 255 * 100)
    : hsv[1]
  return { hue, saturation }
}

const getRedGreenBlue = (colorMode, hue, saturation) => {
  const rgb = colorConvert.hsv.rgb(
    hue,
    // in rgbw mode we set the saturation to 100 here when converting to RGB
    // and then set the white component to the actual saturation
    colorMode === 'rgbw' ? 100 : saturation,
    100
  )
  const ret = { red: rgb[0], green: rgb[1], blue: rgb[2] }
  if (colorMode === 'rgbw') {
    ret.white = 255 - Math.round(saturation / 100 * 255)
  }
  return ret
}

module.exports = homebridge => {
  const Accessory = homebridge.hap.Accessory
  const Characteristic = homebridge.hap.Characteristic
  const Service = homebridge.hap.Service
  const ShellyAccessory = require('./base')(homebridge)

  class ShellyColorLightbulbAccessory extends ShellyAccessory {
    constructor(log, device, colorMode = 'rgbw', platformAccessory = null,
      props = null) {
      if (colorMode !== 'rgb' && colorMode !== 'rgbw') {
        throw new Error(`Invalid color mode "${colorMode}"`)
      }

      const color = getHueSaturation(
        colorMode,
        device.red,
        device.green,
        device.blue,
        device.white
      )

      super(
        log,
        device,
        platformAccessory,
        Object.assign({
          colorMode,
          hue: color.hue,
          saturation: color.saturation,
          _updatingDeviceColor: false,
          _updatingHueSaturation: false,
        }, props)
      )
    }

    createPlatformAccessory() {
      const pa = super.createPlatformAccessory()

      pa.category = Accessory.Categories.LIGHTBULB

      const lightbulbService = new Service.Lightbulb()
        .setCharacteristic(
          Characteristic.On,
          this.device.switch
        )
        .setCharacteristic(
          Characteristic.Hue,
          this.hue
        )
        .setCharacteristic(
          Characteristic.Saturation,
          this.saturation
        )

      if (this.device.hasOwnProperty('gain')) {
        lightbulbService.setCharacteristic(
          Characteristic.Brightness,
          this.device.gain
        )
      }

      pa.addService(lightbulbService)

      return pa
    }

    setupEventHandlers() {
      super.setupEventHandlers()

      const d = this.device
      const lightbulbService = this.platformAccessory
        .getService(Service.Lightbulb)

      lightbulbService
        .getCharacteristic(Characteristic.On)
        .on('set', async (newValue, callback) => {
          if (d.switch === newValue) {
            callback()
            return
          }

          try {
            this.log.debug(
              'Setting state of switch on device',
              d.type,
              d.id,
              'to',
              newValue
            )
            await d.setColor({
              switch: newValue,
            })
            callback()
          } catch (e) {
            handleFailedRequest(this.log, d, e, 'Failed to set switch state')
            callback(e)
          }
        })

      lightbulbService
        .getCharacteristic(Characteristic.Hue)
        .on('set', async (newValue, callback) => {
          if (this.hue === newValue) {
            callback()
            return
          }

          this.hue = newValue
          this._updateDeviceColor()
          callback()
        })

      lightbulbService
        .getCharacteristic(Characteristic.Saturation)
        .on('set', async (newValue, callback) => {
          if (this.saturation === newValue) {
            callback()
            return
          }

          this.saturation = newValue
          this._updateDeviceColor()
          callback()
        })

      d
        .on('change:switch', this.changeSwitchHandler, this)
        .on('change:red', this.changeColorHandler, this)
        .on('change:green', this.changeColorHandler, this)
        .on('change:blue', this.changeColorHandler, this)

      if (this.colorMode === 'rgbw') {
        d.on('change:white', this.changeColorHandler, this)
      }

      if (this.device.hasOwnProperty('gain')) {
        lightbulbService
          .getCharacteristic(Characteristic.Brightness)
          .on('set', async (newValue, callback) => {
            if (this.device.gain === newValue) {
              callback()
              return
            }

            try {
              this.log.debug(
                'Setting gain on device',
                d.type,
                d.id,
                'to',
                newValue
              )
              await d.setColor({
                gain: newValue,
              })
              callback()
            } catch (e) {
              handleFailedRequest(this.log, d, e, 'Failed to set gain')
              callback(e)
            }
          })

        d.on('change:gain', this.changeGainHandler, this)
      }
    }

    changeSwitchHandler(newValue) {
      this.log.debug(
        'Switch state on device',
        this.device.type,
        this.device.id,
        'changed to',
        newValue
      )

      this.platformAccessory
        .getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.On)
        .setValue(newValue)
    }

    changeColorHandler() {
      this._updateHueSaturation()
    }

    changeGainHandler(newValue) {
      this.log.debug(
        'Gain on device',
        this.device.type,
        this.device.id,
        'changed to',
        newValue
      )

      this.platformAccessory
        .getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.Brightness)
        .setValue(newValue)
    }

    _updateDeviceColor() {
      if (this._updatingDeviceColor === true) {
        return
      }
      this._updatingDeviceColor = true

      setImmediate(async () => {
        try {
          const color = getRedGreenBlue(
            this.colorMode,
            this.hue,
            this.saturation
          )

          this.log.debug(
            'Setting color on device',
            this.device.type,
            this.device.id,
            'to',
            Object.values(color).join(',')
          )

          await this.device.setColor(color)
        } catch (e) {
          handleFailedRequest(this.log, this.device, e, 'Failed to set color')
        }

        this._updatingDeviceColor = false
      })
    }

    _updateHueSaturation() {
      if (this._updatingHueSaturation === true) {
        return
      }
      this._updatingHueSaturation = true

      setImmediate(() => {
        const d = this.device
        const color = getHueSaturation(
          this.colorMode,
          d.red,
          d.green,
          d.blue,
          d.white
        )
        const lightbulbService = this.platformAccessory
          .getService(Service.Lightbulb)

        this.hue = color.hue
        this.saturation = color.saturation

        this.log.debug(
          'Color on device',
          d.type,
          d.id,
          'changed to',
          (this.colorMode === 'rgbw'
            ? [d.red, d.green, d.blue, d.white]
            : [d.red, d.green, d.blue]).join(',')
        )

        lightbulbService
          .getCharacteristic(Characteristic.Hue)
          .setValue(this.hue)

        lightbulbService
          .getCharacteristic(Characteristic.Saturation)
          .setValue(this.saturation)

        this._updatingHueSaturation = false
      })
    }

    detach() {
      super.detach()

      this.device
        .removeListener('change:switch', this.changeSwitchHandler, this)
        .removeListener('change:red', this.changeColorHandler, this)
        .removeListener('change:green', this.changeColorHandler, this)
        .removeListener('change:blue', this.changeColorHandler, this)
        .removeListener('change:white', this.changeColorHandler, this)
        .removeListener('change:gain', this.changeGainHandler, this)
    }
  }

  class ShellyWhiteLightbulbAccessory extends ShellyAccessory {
    constructor(log, device, switchProperty = 'switch',
      brightnessProperty = 'brightness', platformAccessory = null,
      props = null) {
      super(
        log,
        device,
        platformAccessory,
        Object.assign({
          _switchProperty: switchProperty,
          _brightnessProperty: brightnessProperty,
        }, props)
      )
    }

    createPlatformAccessory() {
      const pa = super.createPlatformAccessory()

      pa.category = Accessory.Categories.LIGHTBULB

      pa.addService(
        new Service.Lightbulb()
          .setCharacteristic(
            Characteristic.On,
            this.device[this._switchProperty]
          )
          .setCharacteristic(
            Characteristic.Brightness,
            this.device[this._brightnessProperty]
          )
      )

      return pa
    }

    setupEventHandlers() {
      super.setupEventHandlers()

      const d = this.device
      const lightbulbService = this.platformAccessory
        .getService(Service.Lightbulb)

      lightbulbService
        .getCharacteristic(Characteristic.On)
        .on('set', async (newValue, callback) => {
          if (d[this._switchProperty] === newValue) {
            callback()
            return
          }

          try {
            this.log.debug(
              'Setting state of',
              this._switchProperty,
              'on device',
              d.type,
              d.id,
              'to',
              newValue
            )
            await this.setSwitch(newValue)
            callback()
          } catch (e) {
            handleFailedRequest(this.log, d, e, 'Failed to set switch state')
            callback(e)
          }
        })

      lightbulbService
        .getCharacteristic(Characteristic.Brightness)
        .on('set', async (newValue, callback) => {
          if (d[this._brightnessProperty] === newValue) {
            callback()
            return
          }

          try {
            this.log.debug(
              'Setting',
              this._brightnessProperty,
              'on device',
              d.type,
              d.id,
              'to',
              newValue
            )
            await this.setBrightness(newValue)
            callback()
          } catch (e) {
            handleFailedRequest(this.log, d, e, 'Failed to set brightness')
            callback(e)
          }
        })

      d
        .on(`change:${this._switchProperty}`, this.changeSwitchHandler, this)
        .on(
          `change:${this._brightnessProperty}`,
          this.changeBrightnessHandler,
          this
        )
    }

    changeSwitchHandler(newValue) {
      this.log.debug(
        'State of',
        this._switchProperty,
        'on device',
        this.device.type,
        this.device.id,
        'changed to',
        newValue
      )

      this.platformAccessory
        .getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.On)
        .setValue(newValue)
    }

    changeBrightnessHandler(newValue) {
      this.log.debug(
        this._brightnessProperty,
        'on device',
        this.device.type,
        this.device.id,
        'changed to',
        newValue
      )

      this.platformAccessory
        .getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.Brightness)
        .setValue(newValue)
    }

    detach() {
      super.detach()

      this.device
        .removeListener(
          `change:${this._switchProperty}`,
          this.changeSwitchHandler,
          this
        )
        .removeListener(
          `change:${this._brightnessProperty}`,
          this.changeBrightnessHandler,
          this
        )
    }

    setSwitch(newValue) {
      // subclasses should override this
    }

    setBrightness(newValue) {
      // subclasses should override this
    }
  }

  class ShellyBulbColorLightbulbAccessory
    extends ShellyColorLightbulbAccessory {
    constructor(log, device, platformAccessory = null) {
      super(log, device, 'rgbw', platformAccessory)
    }

    get name() {
      const d = this.device
      return d.name || `Shelly Bulb ${d.id}`
    }
  }

  class ShellyRGBW2ColorLightbulbAccessory
    extends ShellyColorLightbulbAccessory {
    constructor(log, device, platformAccessory = null) {
      super(log, device, 'rgb', platformAccessory)
    }

    get name() {
      const d = this.device
      return d.name || `Shelly RGBW2 ${d.id}`
    }

    createPlatformAccessory() {
      const pa = super.createPlatformAccessory()
      pa.context.mode = 'color'
      return pa
    }
  }

  class ShellyRGBW2WhiteLightbulbAccessory
    extends ShellyWhiteLightbulbAccessory {
    constructor(log, device, index, platformAccessory = null) {
      super(
        log,
        device,
        `switch${index}`,
        `brightness${index}`,
        platformAccessory,
        { index }
      )
    }

    get name() {
      const d = this.device
      if (d.name) {
        return `${d.name} #${this.index}`
      } else {
        return `Shelly RGBW2 ${d.id} #${this.index}`
      }
    }

    createPlatformAccessory() {
      const pa = super.createPlatformAccessory()
      pa.context.mode = 'white'
      pa.context.index = this.index
      return pa
    }

    setSwitch(newValue) {
      return this.device.setWhiteChannel(
        this.index,
        this.device[this._brightnessProperty],
        newValue
      )
    }

    setBrightness(newValue) {
      return this.device.setWhiteChannel(
        this.index,
        newValue,
        this.device[this._switchProperty]
      )
    }
  }

  return {
    ShellyBulbColorLightbulbAccessory,
    ShellyRGBW2ColorLightbulbAccessory,
    ShellyRGBW2WhiteLightbulbAccessory,
  }
}

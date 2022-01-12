import * as BaseView from 'app/client/components/BaseView';
import {GristDoc} from 'app/client/components/GristDoc';
import {get as getBrowserGlobals} from 'app/client/lib/browserGlobals';
import {ViewFieldRec, ViewSectionRec} from 'app/client/models/DocModel';
import {AccessLevel, isSatisfied} from 'app/common/CustomWidget';
import {DisposableWithEvents} from 'app/common/DisposableWithEvents';
import {BulkColValues, fromTableDataAction, RowRecord} from 'app/common/DocActions';
import {extractInfoFromColType, reencodeAsAny} from 'app/common/gristTypes';
import {CustomSectionAPI, GristDocAPI, GristView, InteractionOptionsRequest,
        WidgetAPI} from 'app/plugin/grist-plugin-api';
import {MsgType, Rpc} from 'grain-rpc';
import {Computed, dom} from 'grainjs';
import noop = require('lodash/noop');
import debounce = require('lodash/debounce');
import isEqual = require('lodash/isEqual');

/**
 * This file contains a WidgetFrame and all its components.
 *
 * WidgetFrame embeds an external Custom Widget (external webpage) in an iframe. It is used on a CustomView,
 * to display widget content, and on the configuration screen to display widget's configuration screen.
 *
 * Beside exposing widget content, it also exposes some of the API's that Grist offers via grist-rpc.
 * API are defined in the core/app/plugin/grist-plugin-api.ts.
 */

const G = getBrowserGlobals('window');

/**
 * Options for WidgetFrame
 */
export interface WidgetFrameOptions {
  /**
   * Url of external page. Iframe is rebuild each time the URL changes.
   */
  url: string;
  /**
   * Assigned access level. Iframe is rebuild each time access level is changed.
   */
  access: AccessLevel;
  /**
   * If document is in readonly mode.
   */
  readonly: boolean;
  /**
   * Optional callback to configure exposed API.
   */
  configure?: (frame: WidgetFrame) => void;
  /**
   * Optional handler to modify the iframe.
   */
  onElem?: (iframe: HTMLIFrameElement) => void;
}

/**
 * Iframe that embeds Custom Widget page and exposes Grist API.
 */
export class WidgetFrame extends DisposableWithEvents {
  // A grist-rpc object, encapsulated to prevent direct access.
  private _rpc: Rpc;
  // Created iframe element, used to receive and post messages via Rpc
  private _iframe: HTMLIFrameElement | null;

  constructor(private _options: WidgetFrameOptions) {
    super();
    _options.access = _options.access || AccessLevel.none;
    // Build RPC object and connect it to iframe.
    this._rpc = new Rpc({});

    // Register outgoing message handler.
    this._rpc.setSendMessage(msg => this._iframe?.contentWindow!.postMessage(msg, '*'));

    // Register incoming message handler.
    const listener = this._onMessage.bind(this);
    // 'message' is an event's name used by Rpc in window to iframe communication.
    G.window.addEventListener('message', listener);
    this.onDispose(() => {
      // Stop listening for events from the iframe.
      G.window.removeEventListener('message', listener);
      // Stop sending messages to the iframe.
      this._rpc.setSendMessage(noop);
    });

    // Call custom configuration handler.
    _options.configure?.(this);
  }

  /**
   * Attach an EventSource with desired access level.
   */
  public useEvents(source: IEventSource, access: AccessChecker) {
    // Wrap event handler with access check.
    const handler = async (data: any) => {
      if (access.check(this._options.access)) {
        await this._rpc.postMessage(data);
      }
    };
    this.listenTo(source, 'event', handler);
    // Give EventSource a chance to attach to WidgetFrame events.
    source.attach(this);
  }

  /**
   * Exposes API for Custom Widget.
   * TODO: add ts-interface support. Currently all APIs are written in typescript,
   * so those checks are not that needed.
   */
  public exposeAPI(name: string, api: any, access: AccessChecker) {
    this._rpc.registerImpl(name, wrapObject(api, access, this._options.access));
    this.onDispose(() => this._rpc.unregisterImpl(name));
  }

  /**
   * Expose a method for Custom Widget.
   */
  public exposeMethod(name: string, handler: (...args: any[]) => any, access: AccessChecker) {
    this._rpc.registerFunc(name, (...args: any[]) => {
      if (access.check(this._options.access, 'invoke')) {
        return handler(...args);
      } else {
        throwError(this._options.access);
      }
    });
  }

  /**
   * Make configure call to the widget. Widget should open some configuration screen or ignore it.
   */
  public editOptions() {
    return this.callRemote('editOptions');
  }

  /**
   * Call remote function that is exposed by the widget.
   */
  public callRemote(name: string, ...args: any[]) {
    return this._rpc.callRemoteFunc(name, ...args);
  }

  public buildDom() {
    // Append access level to query string.
    const urlWithAccess = (url: string) => {
      if (!url) {
        return url;
      }
      const urlObj = new URL(url);
      urlObj.searchParams.append('access', this._options.access);
      urlObj.searchParams.append('readonly', String(this._options.readonly));
      return urlObj.href;
    };
    const fullUrl = urlWithAccess(this._options.url);
    const onElem = this._options.onElem ?? ((el: HTMLIFrameElement) => el);
    return onElem(
      (this._iframe = dom('iframe', dom.cls('clipboard_focus'), dom.cls('custom_view'), {
        src: fullUrl,
      }))
    );
  }

  private _onMessage(event: MessageEvent) {
    if (this._iframe && event.source === this._iframe.contentWindow && !this.isDisposed()) {
      // Previously, we forwarded messages targeted at "grist" to the back-end.
      // Now, we process them immediately in the context of the client for access
      // control purposes.  To do that, any message that comes in with mdest of
      // "grist" will have that destination wiped, and we provide a local
      // implementation of the interface.
      // It feels like it should be possible to deal with the mdest more cleanly,
      // with a rpc.registerForwarder('grist', { ... }), but it seems somehow hard
      // to call a locally registered interface of an rpc object?
      if (event.data.mdest === 'grist') {
        event.data.mdest = '';
      }
      if (event.data.mtype === MsgType.Ready) {
        this.trigger('ready', this);
      }
      this._rpc.receiveMessage(event.data);
    }
  }
}

const throwError = (access: AccessLevel) => {
  throw new Error('Access not granted. Current access level ' + access);
};

/**
 * Wraps an object to check access level before it is called.
 * TODO: grain-rpc exposes callWrapper which could be used for this purpose,
 * but currently it doesn't have access to the incoming message.
 */
function wrapObject<T extends object>(impl: T, accessChecker: AccessChecker, access: AccessLevel): T {
  return new Proxy(impl, {
    // This proxies all the calls to methods on the API.
    get(target: any, methodName: string) {
      return function () {
        if (methodName === 'then') {
          // Making a proxy for then invocation is not a good idea.
          return undefined;
        }
        if (accessChecker.check(access, methodName)) {
          return target[methodName](...arguments);
        } else {
          throwError(access);
        }
      };
    },
  });
}

/**
 * Interface for custom access rules.
 */
export interface AccessChecker {
  /**
   * Checks if the incoming call can be served on current access level.
   * @param access Current access level
   * @param method Method called on the interface, can use * or undefined to match all methods.
   */
  check(access: AccessLevel, method?: string): boolean;
}

/**
 * Checks if current access level is enough.
 */
export class MinimumLevel implements AccessChecker {
  constructor(private _minimum: AccessLevel) {}
  public check(access: AccessLevel): boolean {
    return isSatisfied(access, this._minimum);
  }
}

type MethodMatcher<T> = keyof T | '*';
/**
 * Helper object that allows assigning access level to a particular method in the interface.
 *
 * Example:
 *
 * 1. Expose two methods, all other will be denied (even in full access mode)
 * new ApiGranularAccess<GristDocAPI>()
 *  .require("read_table", "method1") // for method1 we need at least read_table
 *  .require("none", "method2") // for method2 no access level is needed
 *
 * 2. Expose two methods, all other will require full access (effectively the same as ex. 1)
 * new ApiGranularAccess<GristDocAPI>()
 *  .require("read_table", "method1") // for method1 we need at least read_table
 *  .require("none", "method2") // for method2 no access level is needed
 *  .require("full", "*") // for any other, require full
 *
 * 3. Expose all methods on read_table access, but one can have none
 * new ApiGranularAccess<GristDocAPI>()
 *  .require("none", "method2") // for method2 we are ok with none access
 *  .require("read_table", "*") // for any other, require read_table
 */
export class MethodAccess<T> implements AccessChecker {
  private _accessMap: Map<MethodMatcher<T>, AccessLevel> = new Map();
  constructor() {}
  public require(level: AccessLevel, method: MethodMatcher<T> = '*') {
    this._accessMap.set(method, level);
    return this;
  }
  public check(access: AccessLevel, method?: string): boolean {
    if (!method) {
      throw new Error('Method name is required for MethodAccess check');
    }
    // Check if the iface was registered.
    if (this._accessMap.has(method as MethodMatcher<T>)) {
      // If it was, check that minimum access level is granted.
      const minimum = this._accessMap.get(method as MethodMatcher<T>)!;
      return isSatisfied(access, minimum);
    } else if (this._accessMap.has('*')) {
      // If there is a default rule, check if it permits the access.
      const minimum = this._accessMap.get('*')!;
      return isSatisfied(access, minimum);
    } else {
      // By default, don't allow anything on this interface.
      return false;
    }
  }
}

/***********************
 * Exposed APIs for Custom Widgets.
 *
 * Currently we expose 3 APIs
 * - GristDocAPI - full access to document.
 * - ViewAPI - access to current table.
 * - WidgetAPI - access to widget configuration.
 ***********************/

/**
 * GristDocApi implemented over active GristDoc.
 */
export class GristDocAPIImpl implements GristDocAPI {
  public static readonly defaultAccess = new MethodAccess<GristDocAPI>()
    .require(AccessLevel.read_table, 'getDocName')
    .require(AccessLevel.full); // for any other, require full Access.

  constructor(private _doc: GristDoc) {}

  public async getDocName() {
    return this._doc.docId();
  }

  public async listTables(): Promise<string[]> {
    // Could perhaps read tableIds from this.gristDoc.docModel.allTableIds.all()?
    const tables = await this._doc.docComm.fetchTable('_grist_Tables');
    // Tables the user doesn't have access to are just blanked out.
    return tables[3].tableId.filter(tableId => tableId !== '') as string[];
  }

  public async fetchTable(tableId: string) {
    return fromTableDataAction(await this._doc.docComm.fetchTable(tableId));
  }

  public async applyUserActions(actions: any[][]) {
    return this._doc.docComm.applyUserActions(actions, {desc: undefined});
  }
}

/**
 * GristViewAPI implemented over BaseView.
 */
export class GristViewImpl implements GristView {
  constructor(private _baseView: BaseView) {}

  public async fetchSelectedTable(): Promise<any> {
    const fields: ViewFieldRec[] = this._baseView.viewSection.viewFields().all();
    const rowIds: number[] = this._baseView.sortedRows.getKoArray().peek() as number[];
    const data: BulkColValues = {};
    for (const field of fields) {
      // Use the colId of the displayCol, which may be different in case of Reference columns.
      const colId: string = field.displayColModel.peek().colId.peek();
      const getter = this._baseView.tableModel.tableData.getRowPropFunc(colId)!;
      const typeInfo = extractInfoFromColType(field.column.peek().type.peek());
      data[field.column().colId()] = rowIds.map(r => reencodeAsAny(getter(r)!, typeInfo));
    }
    data.id = rowIds;
    return data;
  }

  public async fetchSelectedRecord(rowId: number): Promise<any> {
    // Prepare an object containing the fields available to the view
    // for the specified row.  A RECORD()-generated rendering would be
    // more useful. but the data engine needs to know what information
    // the custom view depends on, so we shouldn't volunteer any untracked
    // information here.
    const fields: ViewFieldRec[] = this._baseView.viewSection.viewFields().all();
    const data: RowRecord = {id: rowId};
    for (const field of fields) {
      const colId: string = field.displayColModel.peek().colId.peek();
      const typeInfo = extractInfoFromColType(field.column.peek().type.peek());
      data[field.column().colId()] = reencodeAsAny(
        this._baseView.tableModel.tableData.getValue(rowId, colId)!,
        typeInfo
      );
    }
    return data;
  }
}

/**
 * WidgetAPI implemented over active section.
 */
export class WidgetAPIImpl implements WidgetAPI {
  constructor(private _section: ViewSectionRec) {}

  /**
   * Stores options in viewSection.customDef.widgetDef json field.
   * This way whenever widget is changed, options are removed and not shared
   * between widgets by design.
   */
  public async setOptions(options: object): Promise<void> {
    console.debug(`set options`, options);
    if (options === null || options === undefined || typeof options !== 'object') {
      throw new Error('options must be a valid JSON object');
    }
    this._section.activeCustomOptions(options);
  }

  public async getOptions(): Promise<Record<string, unknown> | null> {
    console.debug(`getOptions`);
    return this._section.activeCustomOptions.peek() ?? null;
  }

  public async clearOptions(): Promise<void> {
    console.debug(`clearOptions`);
    this._section.activeCustomOptions(null);
  }

  public async setOption(key: string, value: any): Promise<void> {
    console.debug(`setOption(${key}, ${value})`);
    const options = {...this._section.activeCustomOptions.peek()};
    options[key] = value;
    this._section.activeCustomOptions(options);
  }

  public getOption(key: string): Promise<unknown> {
    console.debug(`getOption(${key})`);
    const options = this._section.activeCustomOptions.peek();
    return options?.[key];
  }
}

/************************
 * Events that are sent to the CustomWidget.
 *
 * Currently:
 * - onRecord, implemented by RecordNotifier, sends a message each time active row is changed.
 * - onRecords, implemented by TableNotifier, sends a message each time table is changed
 * - onOptions, implemented by ConfigNotifier, sends a message each time configuration is changed
 *
 * All of those events are also sent when CustomWidget sends its ready message.
 ************************/

/**
 * EventSource should trigger event called "event" that will be send to the Custom Widget.
 */
export interface IEventSource extends DisposableWithEvents {
  /**
   * Called by WidgetFrame, allowing EventSource to attach to its ready event.
   */
  attach(frame: WidgetFrame): void;
}

export class BaseEventSource extends DisposableWithEvents implements IEventSource {
  // Attaches to WidgetFrame ready event.
  public attach(frame: WidgetFrame): void {
    this.listenTo(frame, 'ready', this._ready.bind(this));
  }
  protected _ready() {
    // To override if needed to react on the ready event.
  }
  protected _notify(data: any) {
    if (this.isDisposed()) {
      return;
    }
    this.trigger('event', data);
  }
}

/**
 * Notifies about cursor position change. Exposed in the API as a onRecord handler.
 */
export class RecordNotifier extends BaseEventSource {
  private _debounced: () => void; // debounced call to let the view know linked cursor changed.
  constructor(private _baseView: BaseView) {
    super();
    this._debounced = debounce(() => this._update(), 0);
    this.autoDispose(_baseView.cursor.rowIndex.subscribe(this._debounced));
  }

  private _update() {
    if (this.isDisposed()) {
      return;
    }
    const state = {
      tableId: this._baseView.viewSection.table().tableId(),
      rowId: this._baseView.cursor.getCursorPos().rowId || undefined,
      dataChange: false,
    };
    this._notify(state);
  }
}

/**
 * Notifies about options position change. Exposed in the API as a onOptions handler.
 */
export class ConfigNotifier extends BaseEventSource {
  private _currentConfig: Computed<any | null>;
  private _debounced: () => void; // debounced call to let the view know linked cursor changed.
  constructor(private _section: ViewSectionRec, private _accessLevel: AccessLevel) {
    super();
    this._currentConfig = Computed.create(this, use => {
      const options = use(this._section.activeCustomOptions);
      return options;
    });
    this._debounced = debounce(() => this._update(), 0);
    this.autoDispose(
      this._currentConfig.addListener((cur, prev) => {
        if (isEqual(prev, cur)) {
          return;
        }
        this._debounced();
      })
    );
  }

  protected _ready() {
    // On ready, send initial configuration.
    this._debounced();
  }

  private _update() {
    if (this.isDisposed()) {
      return;
    }
    this._notify({
      options: this._currentConfig.get(),
      settings: {accessLevel: this._accessLevel},
    });
  }
}

/**
 * Notifies about cursor table data or structure change.
 * Exposed in the API as a onRecords handler.
 * This Notifier sends an initial event when subscribed
 */
export class TableNotifier extends BaseEventSource {
  private _debounced: () => void; // debounced call to let the view know linked data changed.
  constructor(private _baseView: BaseView) {
    super();
    this._debounced = debounce(() => this._update(), 0);
    this.autoDispose(_baseView.viewSection.viewFields().subscribe(this._debounced));
    this.listenTo(_baseView.sortedRows, 'rowNotify', this._debounced);
    this.autoDispose(_baseView.sortedRows.getKoArray().subscribe(this._debounced));
  }

  protected _ready() {
    // On ready, send initial table information.
    this._debounced();
  }

  private _update() {
    if (this.isDisposed()) {
      return;
    }
    const state = {
      tableId: this._baseView.viewSection.table().tableId(),
      rowId: this._baseView.cursor.getCursorPos().rowId || undefined,
      dataChange: true,
    };
    this._notify(state);
  }
}

export class CustomSectionAPIImpl implements CustomSectionAPI {
  constructor(
    private _section: ViewSectionRec,
    private _currentAccess: AccessLevel,
    private _promptCallback: (access: AccessLevel) => void
  ) {}
  /**
   * Method called as part of ready message. Allows widget to request for particular features or inform about
   * capabilities.
   */
  public async configure(settings: InteractionOptionsRequest): Promise<void> {
    if (settings.hasCustomOptions !== undefined) {
      this._section.hasCustomOptions(settings.hasCustomOptions);
    }
    if (settings.requiredAccess && settings.requiredAccess !== this._currentAccess) {
      this._promptCallback(settings.requiredAccess as AccessLevel);
    }
  }
}
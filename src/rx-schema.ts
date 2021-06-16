import deepEqual from 'deep-equal';

import {
    clone,
    hash,
    sortObject,
    pluginMissing,
    overwriteGetterForCaching
} from './util';
import {
    newRxError,
} from './rx-error';
import {
    runPluginHooks
} from './hooks';
import {
    defineGetterSetter
} from './rx-document';

import type {
    RxJsonSchema
} from './types';

export class RxSchema<T = any> {
    public indexes: string[][];
    public primaryPath: keyof T;
    public finalFields: string[];

    constructor(
        public readonly jsonSchema: RxJsonSchema<T>
    ) {
        this.indexes = getIndexes(this.jsonSchema);

        // primary is always required
        this.primaryPath = this.jsonSchema.primaryKey;
        if (this.primaryPath) {
            (this.jsonSchema as any).required.push(this.primaryPath);
        }

        // final fields are always required
        this.finalFields = getFinalFields(this.jsonSchema);
        this.jsonSchema.required = (this.jsonSchema as any).required
            .concat(this.finalFields)
            .filter((elem: any, pos: any, arr: any) => arr.indexOf(elem) === pos); // unique;
    }

    public get version(): number {
        return this.jsonSchema.version;
    }

    get normalized(): RxJsonSchema<T> {
        return overwriteGetterForCaching(
            this,
            'normalized',
            normalize(this.jsonSchema)
        );
    }

    public get topLevelFields(): (keyof T)[] {
        return Object.keys(this.normalized.properties) as (keyof T)[];
    }

    public get defaultValues(): { [P in keyof T]: T[P] } {
        const values = {} as { [P in keyof T]: T[P] };
        Object
            .entries(this.normalized.properties)
            .filter(([, v]) => (v as any).hasOwnProperty('default'))
            .forEach(([k, v]) => (values as any)[k] = (v as any).default);
        return overwriteGetterForCaching(
            this,
            'defaultValues',
            values
        );
    }

    /**
        * true if schema contains at least one encrypted path
        */
    get crypt(): boolean {
        if (
            !!this.jsonSchema.encrypted && this.jsonSchema.encrypted.length > 0 ||
            this.jsonSchema.attachments && this.jsonSchema.attachments.encrypted
        ) {
            return true;
        } else {
            return false;
        }
    }

    /**
     * get all encrypted paths
     */
    get encryptedPaths(): string[] {
        return this.jsonSchema.encrypted || [];
    }

    /**
     * @overrides itself on the first call
     */
    public get hash(): string {
        return overwriteGetterForCaching(
            this,
            'hash',
            hash(this.normalized)
        );
    }

    /**
     * checks if a given change on a document is allowed
     * Ensures that:
     * - primary is not modified
     * - final fields are not modified
     * @throws {Error} if not valid
     */
    validateChange(dataBefore: any, dataAfter: any): void {
        this.finalFields.forEach(fieldName => {
            if (!deepEqual(dataBefore[fieldName], dataAfter[fieldName])) {
                throw newRxError('DOC9', {
                    dataBefore,
                    dataAfter,
                    fieldName
                });
            }
        });
    }

    /**
     * validate if the obj matches the schema
     * @overwritten by plugin (required)
     * @param schemaPath if given, validates agains deep-path of schema
     * @throws {Error} if not valid
     * @param obj equal to input-obj
     */
    public validate(_obj: any, _schemaPath?: string): void {
        throw pluginMissing('validate');
    }

    /**
     * fills all unset fields with default-values if set
     */
    fillObjectWithDefaults(obj: any): any {
        obj = clone(obj);
        Object
            .entries(this.defaultValues)
            .filter(([k]) => !obj.hasOwnProperty(k) || typeof obj[k] === 'undefined')
            .forEach(([k, v]) => obj[k] = v);
        return obj;
    }

    /**
     * creates the schema-based document-prototype,
     * see RxCollection.getDocumentPrototype()
     */
    public getDocumentPrototype(): any {
        const proto = {};
        defineGetterSetter(this, proto, '');
        overwriteGetterForCaching(
            this,
            'getDocumentPrototype',
            () => proto
        );
        return proto;
    }
}

export function getIndexes<T = any>(
    jsonSchema: RxJsonSchema<T>
): string[][] {
    return (jsonSchema.indexes || []).map(index => Array.isArray(index) ? index : [index]);
}

/**
 * array with previous version-numbers
 */
export function getPreviousVersions(schema: RxJsonSchema<any>): number[] {
    const version = schema.version ? schema.version : 0;
    let c = 0;
    return new Array(version)
        .fill(0)
        .map(() => c++);
}

/**
 * returns the final-fields of the schema
 * @return field-names of the final-fields
 */
export function getFinalFields<T = any>(
    jsonSchema: RxJsonSchema<T>
): string[] {
    const ret = Object.keys(jsonSchema.properties)
        .filter(key => (jsonSchema as any).properties[key].final);

    // primary is also final
    ret.push(jsonSchema.primaryKey as any);
    return ret;
}

/**
 * orders the schemas attributes by alphabetical order
 * @return jsonSchema - ordered
 */
export function normalize<T>(jsonSchema: RxJsonSchema<T>): RxJsonSchema<T> {
    const normalizedSchema: RxJsonSchema<T> = sortObject(clone(jsonSchema));
    if (jsonSchema.indexes) {
        normalizedSchema.indexes = Array.from(jsonSchema.indexes); // indexes should remain unsorted
    }
    if (!jsonSchema.required) {
        jsonSchema.required = [jsonSchema.primaryKey];
    } else if (!jsonSchema.required.includes(jsonSchema.primaryKey)) {
        jsonSchema.required.push(jsonSchema.primaryKey);
    }
    return normalizedSchema;
}

/**
 * fills the schema-json with default-settings
 * @return cloned schemaObj
 */
export function fillWithDefaultSettings<T = any>(
    schemaObj: RxJsonSchema<T>
): RxJsonSchema<T> {
    schemaObj = clone(schemaObj);

    // additionalProperties is always false
    schemaObj.additionalProperties = false;

    // fill with key-compression-state ()
    if (!schemaObj.hasOwnProperty('keyCompression')) {
        schemaObj.keyCompression = false;
    }

    // indexes must be array
    schemaObj.indexes = schemaObj.indexes || [];

    // required must be array
    schemaObj.required = schemaObj.required || [];

    // encrypted must be array
    schemaObj.encrypted = schemaObj.encrypted || [];



    /**
     * TODO we should not need to added the internal fields to the schema.
     * Better remove the before validation.
     */
    // add _rev
    (schemaObj.properties as any)._rev = {
        type: 'string',
        minLength: 1
    };

    // add attachments
    (schemaObj.properties as any)._attachments = {
        type: 'object'
    };

    // add deleted flag
    (schemaObj.properties as any)._deleted = {
        type: 'boolean'
    };


    // version is 0 by default
    schemaObj.version = schemaObj.version || 0;

    return schemaObj;
}

export function createRxSchema<T>(
    jsonSchema: RxJsonSchema<T>,
    runPreCreateHooks = true
): RxSchema<T> {
    if (runPreCreateHooks) {
        runPluginHooks('preCreateRxSchema', jsonSchema);
    }
    const schema = new RxSchema(fillWithDefaultSettings(jsonSchema));
    runPluginHooks('createRxSchema', schema);
    return schema;
}

export function isInstanceOf(obj: any): boolean {
    return obj instanceof RxSchema;
}

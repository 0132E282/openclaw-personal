import {defineFeaturePlugin} from 'openclaw/plugin-sdk/feature-plugin';
import {defineFeatureContract} from 'openclaw/plugin-sdk/feature-contract';
export default defineFeaturePlugin({
 contract:defineFeatureContract({pluginId:'openclaw-personal',operations:{},events:{}}),
 name:'Personal',description:'Official web launchers only. No inbox sync or sending.',setup(){return {};}
});

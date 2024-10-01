const axios = require('axios');
const csv = require('csv-parser');
const Shopify = require('shopify-api-node');
require('dotenv').config();
const stream = require('stream');
const { promisify } = require('util');
const fs = require('fs');

const pipeline = promisify(stream.pipeline);

const shopify = new Shopify({
    shopName: process.env.SHOP,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const handleRateLimit = async (error) => {
    if (error.extensions && error.extensions.code === 'THROTTLED') {
        const retryAfter = parseInt(error.extensions.retryAfter) || 2000; // Default wait time of 2 seconds if no retryAfter is provided
        console.log(`Rate limited! Waiting for ${retryAfter} ms before retrying...`);
        await wait(retryAfter); // Wait for the time suggested by Shopify (or 2 seconds)
    } else {
        throw error; // If it's not a rate-limiting error, rethrow it
    }
};


async function fetch_csv_products() {
    const products = [];
    try {
        await pipeline(
            fs.createReadStream('private_repo/clean_data/to_update.csv'),
            csv(),
            new stream.Writable({
                objectMode: true,
                write(product, encoding, callback) {
                    products.push(product);
                    callback();
                }
            })
        );
    } catch (error) {
        console.log(`Error fetching products: ${error}`);
    }
    return products;
}

const updateInventoryQuantityAndCost = async (sku, newQty, newCost) => {
    try {
        const query = `
        {
            productVariants(first: 100, query: "sku:${sku}") {
                edges {
                    node {
                        id
                        title
                        sku
                        product {
                            title
                            id
                            handle
                        }
                        inventoryItem {
                            id
                            unitCost {
                                amount
                                currencyCode
                            }
                            inventoryLevels(first: 100) {
                                edges {
                                    node {
                                        id
                                        available
                                        location {
                                            id
                                            name
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`;

        const response = await shopify.graphql(query);

        if (response && response.productVariants.edges.length > 0) {
            const variant = response.productVariants.edges[0].node;
            const inventoryItemId = variant.inventoryItem.id;
            const inventoryLevels = variant.inventoryItem.inventoryLevels.edges;

            // Log the current cost
            const currentCost = variant.inventoryItem.unitCost;
            if (currentCost) {
                console.log('Current cost found!')
                // console.log(`Current Cost: ${currentCost.amount} ${currentCost.currencyCode}`);
            } else {
                console.log('No existing cost found.');
            }

            // Update the inventory item cost
            const updateInventoryMutation = `
            mutation inventoryItemUpdate($id: ID!, $input: InventoryItemUpdateInput!) {
                inventoryItemUpdate(id: $id, input: $input) {
                    inventoryItem {
                        id
                        unitCost {
                            amount
                        }
                    }
                    userErrors {
                        message
                    }
                }
            }
            `;

            const variables = {
                id: inventoryItemId,
                input: {
                    cost: parseFloat(newCost)
                }
            };

            const updateResponse = await shopify.graphql(updateInventoryMutation, variables);
            if (updateResponse.inventoryItemUpdate.userErrors.length > 0) {
                console.log(`User Errors:`, updateResponse.inventoryItemUpdate.userErrors);
            } else {
                console.log(`Updated Inventory Item`);
            }

            if (inventoryLevels.length >= 3) {
                const inventoryLevel = inventoryLevels[2]; 
                const currentQty = inventoryLevel.node.available;
                const newDelta = newQty - currentQty;

                const updateInventoryLevelMutation = `
                mutation adjustInventory($id: ID!, $delta: Int!) {
                    inventoryAdjustQuantity(input: {inventoryLevelId: $id, availableDelta: $delta}) {
                        inventoryLevel {
                            id
                            available
                        }
                        userErrors {
                            message
                        }
                    }
                }
                `;

                const inventoryLevelVariables = {
                    id: inventoryLevel.node.id,
                    delta: newDelta
                };

                const inventoryLevelResponse = await shopify.graphql(updateInventoryLevelMutation, inventoryLevelVariables);
                if (inventoryLevelResponse.inventoryAdjustQuantity.userErrors.length > 0) {
                    console.log(`Inventory Level Update Errors:`, inventoryLevelResponse.inventoryAdjustQuantity.userErrors);
                } 
            } else {
                if (inventoryLevels.length >= 2) {
                    const inventoryLevel = inventoryLevels[1]; 
                    const currentQty = inventoryLevel.node.available;
                    const newDelta = newQty - currentQty;
    
                    const updateInventoryLevelMutation = `
                    mutation adjustInventory($id: ID!, $delta: Int!) {
                        inventoryAdjustQuantity(input: {inventoryLevelId: $id, availableDelta: $delta}) {
                            inventoryLevel {
                                id
                                available
                            }
                            userErrors {
                                message
                            }
                        }
                    }
                    `;
    
                    const inventoryLevelVariables = {
                        id: inventoryLevel.node.id,
                        delta: newDelta
                    };
    
                    const inventoryLevelResponse = await shopify.graphql(updateInventoryLevelMutation, inventoryLevelVariables);
                    if (inventoryLevelResponse.inventoryAdjustQuantity.userErrors.length > 0) {
                        console.log(`Inventory Level Update Errors:`, inventoryLevelResponse.inventoryAdjustQuantity.userErrors);
                    } else {
                        console.log('Updated inventory!')
                        // console.log(`Updated Inventory for Location ID ${inventoryLevel.node.location.id} to ${inventoryLevelResponse.inventoryAdjustQuantity.inventoryLevel.available}.`);
                    }
                } else {
                    console.log('Not enough locations available to update inventory.');
                    return sku
                }
            }

        } else {
            console.log(`SKU ${sku} not found or has no variants.`);
        }

    } catch (error) {
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            await handleRateLimit(error);
            return updateInventoryQuantityAndCost(sku, newQty, newCost); // Retry after waiting
        } else {
            console.error(`Error updating SKU ${sku}:`, error);
        }
    }
    console.log('\n=========\n');
};

async function updateInventoryFromFetchedCSV() {
    const products = await fetch_csv_products();
    // const not_enough_inventory = []

    for (let i = 0; i < products.length; i++) {
        const product = products[i];
        const sku = product["Product Code"];
        const quantity = parseInt(product["Inventory"]);
        const cost = parseFloat(product['Unit Cost']); // Ensure cost is a number

        if (sku && !isNaN(quantity)) {
            await updateInventoryQuantityAndCost(sku, quantity, cost);
            
        }
    }

}

updateInventoryFromFetchedCSV();